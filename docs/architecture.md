# dsh-kimicode-swarm 架构

> 2026-08-15。把 Kimi Code Swarm 模式的「批量并行子 Agent 调度」搬进 DeepSeek Harness，
> 并在模型分配与前端可视化上超越原版。本文介绍分层架构、调度合约、事件流设计与
> 落地过程中的关键决策。

## 1. 目标

1. **swarm_batch 工具**：模型可调用的批量派发工具，模板 + items 生成子任务，并发调度
   执行，结构化结果返回（Kimi 风格 XML）。
2. **模型三级分配**：显式指定 > 设置映射表 > LLM 自由分配（继承调用者）。
3. **聊天内实时进度条**：每个子 Agent 一行状态（排队/运行中/完成），运行中实时刷新。
4. **/swarm 命令**：一次性 Swarm 模式，对齐 Kimi 的 task 触发语义。

## 2. 分层架构

```
┌─ host 半区（node 进程）──────────────────────────────────────┐
│  src/index.ts  — 插件入口                                     │
│    ├─ ctx.tools.register(swarm_batch)                        │
│    │    ├─ core/normalize.ts：参数归一化                      │
│    │    ├─ core/scheduler.ts：两阶段自适应并发调度            │
│    │    ├─ ctx.subagents.start()：真实子 Agent 启动          │
│    │    └─ progress.ts：createProgressBroadcaster → SSE 帧   │
│    │        （/swarm-events 路由，SWARM_PROGRESS_ROUTE）       │
│    ├─ ctx.commands.register(/swarm)                          │
│    ├─ installSettingsSection('swarm')                        │
│    └─ systemPrompt.section（插件公告）                        │
└──────────────────────────────────────────────────────────────┘
┌─ browser 半区（Web GUI）─────────────────────────────────────┐
│  src/client/index.ts — apply：开同源 EventSource + 注册槽位    │
│  src/client/progress-store.ts — 模块级进度存储（按 callId）    │
│  src/client/SwarmCard.tsx — tool.call.toolview keyed 视图     │
│  src/client/SwarmSettingsCard.tsx — 设置卡片                  │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 host 半区

- **工具注册**：`ctx.tools.register(defineTool(...))`（`@deepseek-ai/dsh-tools` SDK）。
  工具执行上下文 `exec` 携带 `agent`（调用者 Agent）——`ctx.subagents.start()` 需要它
  作为 `parent`。
- **子 Agent 启动**：`ctx.subagents.start('spawn', { label, prompt, parent, signal,
  agentOptions })`——`agentOptions.provider/model` 即模型分配落点；不传则继承调用者
  模型（DSH 原生行为）。
- **命令**：`ctx.commands.register({ name: 'swarm', handler })`，handler 用
  `invocation.agent.steer(createUserMessage(...))` 注入一次性 Swarm 模式工作流指令。
- **设置**：`installSettingsSection` 注册 `swarm` 命名空间（模型映射表等），
  `systemPrompt.section` 向 Agent 公告插件能力。

### 2.2 core（纯逻辑，与运行时解耦）

| 模块 | 职责 |
|---|---|
| `types.ts` | 工具参数 schema（dsh-tools ParameterSchemaSpec）、任务/结果类型 |
| `normalize.ts` | 参数归一化：模板填充、模型三级解析、重复 prompt 拒绝、resume 优先 |
| `scheduler.ts` | 两阶段自适应调度器（注入 SpawnFn + 时钟，单测假实现驱动） |

调度器对外只依赖一个函数签名 `SpawnFn = (task, signal) => Promise<SwarmAttemptResult>`
和可选 `onProgress` 回调——任何运行时（subagents、会话、mock）都能接入。

### 2.3 browser 半区

- **进度通道**：host 端 `createProgressBroadcaster()`（`src/progress.ts`）持有按
  callId 的全量快照存储与 SSE 帧写入器，经 `ctx.webServer.register` 挂在
  `/swarm-events` 路由（`SWARM_PROGRESS_ROUTE`）；client 端 `apply()` 开同源
  EventSource 订阅该路由，把 `progress` 事件帧写入模块级 `progress-store`
  （按 callId 存最新快照）；`SwarmCard` 按 `block.callId` 订阅渲染。进度是纯展示
  数据，**不写入会话日志**——rc.8 拒绝词表外会话事件（`swarm/progress` 不在宿主
  词表内，append 也无法标记可忽略），写进去会直接毁掉整个会话。
- **面板**：`tool.call.toolview` keyed 视图（官方文档明示支持「a tool your own
  package registered」）。运行中渲染 LiveRow（排队/运行中/完成，蓝点脉冲动画）；
  完成后从 `ToolResultNode.meta`（presentationMeta 结构化投影）渲染结果面板。

## 3. 调度合约（对齐 Kimi SubagentBatch）

公开的调度数值直接照抄 Kimi 源码中的工程参数：

**正常阶段**
- 立即启动前 5 个（`INITIAL_LAUNCH_LIMIT = 5`）；之后每 700ms 爬坡 1 个
  （`INITIAL_LAUNCH_INTERVAL_MS = 700`）。
- 可选环境变量式并发上限（本插件为构造参数 `maxConcurrency`）。

**限流阶段**
- 某 provider 限流（错误特征匹配 rate limit / 429 / quota / 限流）：该任务以
  3s/6s/12s 指数退避重试（`RATE_LIMIT_RETRY_BASE_MS = 3000`，翻倍），requeue 到队首。
- 进入限流阶段：并发容量 = 已成功启动数（最小 1）；后续每次限流容量 -1（最小 1，
  每 2000ms 至多一次）；3 分钟无新限流则容量 +1 恢复。
- 限流阶段每 pass 最多启动 1 个任务；**限流的是唯一未完成任务时直接判失败**，
  避免整批永久挂起。

**取消与超时**
- 用户取消（signal abort）：已完成结果保留，已启动未完成标 `aborted/started`，
  未启动标 `aborted/not_started`。
- 单任务超时只失败该任务，不阻断其他任务。

**去重**
- 展开后 prompt 完全相同的两项直接拒绝（`Duplicate subagent prompts`）。

## 4. 与 Kimi 原版对照（源码已核实）

| 能力 | Kimi Code Swarm | dsh-kimicode-swarm |
|---|---|---|
| 批量派发 | AgentSwarm，items ≤ 128 | 同构，`swarm_batch` |
| 子 Agent 类型 | `subagent_type`（coder 默认） | 同构，透传 |
| 模型选择 | `model: primary\|secondary` 整批二选一，**默认关闭的实验** | 每 item 可显式指定，或映射表，或继承调用者（LLM 自由） |
| 调度 | 5 + 700ms 爬坡；限流指数退避；容量自适应 | 同参数实现 |
| 失败续做 | `resume_agent_ids` | 同构 |
| 前端 | TUI 文本状态行 | Web 聊天内实时进度条（SSE `/swarm-events` + EventSource） |
| 冲突保护 | 无文件锁，靠语义拆分 | 同（不重复造） |

## 5. 进度事件设计

早期设计把进度作为 `swarm/progress` 会话事件（`SessionEventMap` 模块扩展 + mux 流）下发，
在 rc.8 迁移中废弃（commit 1c09744）：rc.8 会话日志在读取时拒绝词表外事件类型，
`append()` 也无法把该事件标记为可忽略——写进日志会毁掉整个会话。进度因此改为
**纯展示的 SSE 通道**，与会话日志完全隔离。

```ts
// src/progress.ts
export const SWARM_PROGRESS_ROUTE = '/swarm-events'   // host 路由
export const SWARM_PROGRESS_EVENT = 'progress'        // SSE 事件名

export interface SwarmProgressFrame {
  callId: string
  subagents: Array<{
    index: number
    item: string | null
    type: string | null
    model: string | null
    status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
  }>
}
```

- **快照式**：每次状态变化发全量有序列表（输入顺序），最新一帧即可重建完整状态，
  客户端无需增量合并。帧序列化为一条 SSE 记录：`event: progress` + JSON `data`。
- **传输**：host 端 `createProgressBroadcaster()` 维护附件集合与共享心跳定时器
  （15s，防代理掐空闲连接），`publish()` 把一帧写给所有附件，写失败自动摘除；
  路由经 `ctx.webServer.register` 挂在 `/swarm-events`（无 web 层时跳过注册）。
  client 端 `apply()` 开同源 EventSource（相对 URL，浏览器与宿主同源），
  `progress` 事件帧写入模块级 `progress-store`（按 callId 存最新快照）。
- **生命周期**：EventSource 随插件生命周期常驻；store 按 callId 存最新快照，
  卡片挂载时先读快照再订阅增量。
- 运行中状态：`queued`（排队，灰点）→ `running`（运行中，蓝点脉冲）→
  `completed/failed/aborted`（终态着色）。

## 6. 关键决策记录

1. **不嵌套子工具调用**：DSH 的嵌套 dispatch（`subCalls`）与 Code Mode 绑定，普通工具
   不可用；进度走自定义 SSE 路由 + 同源 EventSource（官方 webServer 扩展点），
   零宿主改动。早期曾用自定义会话事件 + mux 流，rc.8 拒绝词表外会话事件后废弃
   （commit 1c09744），进度改为纯展示通道，不落会话日志。
2. **调度器必须等全部 settle**：早期实现同步返回半空结果数组导致
   `Cannot read properties of undefined (reading 'agentId')`（真实异步 spawn 场景）；
   已加 `allSettled` 屏障 + 回归测试。
3. **inject 声明必须齐全**：host 端漏 `export const inject` 会
   `cannot get property ... without inject` 启动崩溃（cordis 硬约束）；
   client 端 `settingsScope.bind` 要求注入 `connection` 与 `remote`。
4. **公告文案避开 `{{item}}` 字面量**：系统提示词渲染器把 `{{...}}` 当变量引用，
   未知变量即抛错。
5. **设置页白名单限制**（平台级，非本插件缺陷）：`dsh-host-apiproxy` 的
   `WEB_SETTINGS_NAMESPACES` 硬编码，插件自注册 ns 对配置客户端
   `settings-not-exposed`；官方注释将「暴露声明移入 settings.register()」列为
   deferred work。配置暂走 profile patch entry config / settings.yaml。

## 7. 测试与验收

- 30 个单元测试：爬坡节奏、限流退避与容量恢复、取消状态保留、超时独立失败、
  回归（异步 spawn 不提前返回）、参数归一化（模型解析/去重/边界）、进度广播
  （帧序列化/扇出/心跳/摘除）。
- 真实压测（2026-08-15）：3/12/30 任务三轮全绿；20 任务慢任务（sleep 4s）实测
  中间态「8 完成 + 6 运行中 + 6 排队」实时刷新，完成后无缝切换结果面板。
