<p align="center">
  <strong>dsh-kimicode-swarm</strong> — DeepSeek Harness 批量并行子 Agent 调度
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <img src="https://img.shields.io/badge/Host-DeepSeek%20Harness-informational?style=flat-square" alt="DeepSeek Harness" />
  <img src="https://img.shields.io/badge/Tests-48%20passed-brightgreen?style=flat-square" alt="48 unit tests" />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
</p>

<p align="center">
  <a href="./README.en.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/swarm-banner.zh.png" alt="dsh-kimicode-swarm" width="85%" />
</p>

---

把 **Kimi Code Swarm 模式**（主从式多 Agent 并行）搬进 DeepSeek Harness：主 Agent 把任务
拆成互不依赖的子任务，`swarm_batch` 一次批量派发，子 Agent 并行执行，完成后汇总——
官方基准下端到端效率最高提升 4.5 倍。**聊天内实时进度条**：每个子 Agent 一行状态
（排队 / 运行中 / 完成），像 Kimi 的 TUI 一样看着任务逐个点亮。

## 特性

- **`swarm_batch` 工具**：`prompt_template` + `items` 批量生成子任务（最多 128 项），
  每项可带 `model` / `type`；`resume_agent_ids` 断点续做。
- **自适应调度**（对齐 Kimi SubagentBatch 调度合约）：先 5 个并发 + 每 700ms 爬坡 1 个；
  撞限流指数退避（3s/6s/12s…）并自适应收缩/恢复并发容量；用户取消保留已完成结果；
  单任务超时只失败该任务。
- **`/swarm <任务>` 命令**：一次性 Swarm 模式——探索边界、拆解子任务、批量派发、
  汇总结果、自动退出模式（对齐 Kimi 的 task 触发语义）。
- **聊天内实时进度条**：host 端把全量快照进度帧经 SSE 路由（`/swarm-events`）广播，
  浏览器端用同源 EventSource 订阅写入 progress-store 渲染，运行中蓝点脉冲、排队灰点、
  完成绿点。进度仅用于展示，不写入会话日志（rc.8 拒绝词表外会话事件）。
- **模型三级分配**：item 级/整批显式 `model` > 设置映射表（按 type 命中）> 继承调用者
  模型（默认，由 Agent 自由分配）。

## 架构

```
┌─ host 半区（node 进程，src/index.ts）─────────────────────────┐
│  swarm_batch 工具（ctx.tools.register）                        │
│    ├─ 参数归一化（core/normalize.ts）：模板填充 / 模型解析 / 去重 │
│    ├─ SwarmScheduler（core/scheduler.ts）：两阶段自适应并发调度  │
│    │    └─ onProgress 回调：每步状态变化发全量快照              │
│    ├─ ctx.subagents.start()：真实子 Agent 启动（继承调用者模型） │
│    └─ progress.ts：createProgressBroadcaster → SSE 帧          │
│        （/swarm-events 路由，SWARM_PROGRESS_ROUTE）              │
│  /swarm 命令（ctx.commands.register）：一次性 Swarm 模式指令     │
│  设置命名空间 + 系统提示词公告                                  │
└──────────────────────────────────────────────────────────────┘
                            │ SSE（event: progress，JSON 快照）
┌─ browser 半区（Web GUI，src/client/）─────────────────────────┐
│  index.ts：同源 EventSource 订阅 /swarm-events                  │
│  progress-store.ts：模块级进度存储（按 callId 存最新快照）        │
│  SwarmCard.tsx：tool.call.toolview keyed 视图                   │
│    ├─ 运行中：每子 Agent 一行实时状态（排队/运行中/完成）        │
│    └─ 完成后：结果面板（每行可展开，汇总自 presentationMeta）    │
│  SwarmSettingsCard.tsx：设置卡片（模型映射表，模型目录动态拉取）  │
└──────────────────────────────────────────────────────────────┘
```

关键设计决策：

- **调度核心与运行时解耦**：`core/` 是纯逻辑（注入 SpawnFn 与时钟），单测用假实现
  驱动，不依赖宿主类型（参照 dsh-task-board 的 framework-free 风格）。
- **进度走专用 SSE 路由而非会话事件**：rc.8 拒绝词表外会话事件（`swarm/progress` 不在
  宿主词表内，append 也无法标记可忽略），进度快照改由 host 端经 `/swarm-events` 路由
  广播、浏览器端同源 EventSource 订阅——零宿主改动，会话日志保持干净。
- **模型分配默认交还 LLM**：不传 `model` 即继承调用者模型，Agent 按任务难度自行
  分配；显式指定始终优先。

## 安装

已发布到 **npm**（`dsh-kimicode-swarm`），一行装进任意 DSH profile：

```bash
dsh plugin --profile web add dsh-kimicode-swarm
# 等价于:
pnpm add dsh-kimicode-swarm
```

或从 GitHub / 本地直接装：

```bash
pnpm add github:hongyue0721/dsh-kimicode-swarm   # 或
pnpm add file:/path/to/dsh-kimicode-swarm
```

装完重启 `dsh web`，**新会话**可见 `swarm_batch` 工具与 `/swarm` 命令。

## 使用

**让 Agent 干活**：直接描述任务，Agent 会自行判断是否值得批量并行；或明确要求
「用 swarm 批量派发」。

**快捷命令**：

```
/swarm 审查这三个模块的代码并给出修复建议
```

**模型分配**：默认继承调用者模型；想按任务指定，给 `items` 的某项写
`{ "item": "...", "model": "deepseek-v4-pro" }`，或整批传 `model` 字段。

**`swarm_batch` 参数**（模型侧契约）：

| 参数 | 说明 |
|---|---|
| `description` | 整个 swarm 的简短描述 |
| `subagent_type` | 子 Agent 类型（默认 `coder`） |
| `model` | 整批模型覆盖（显式优先于映射表） |
| `prompt_template` | 必填，含 `{{item}}` 占位符 |
| `items` | 2..128 项（提供 `resume_agent_ids` 时可少于 2 项）；`string` 或 `{ item, model?, type? }` |
| `resume_agent_ids` | `agent_id -> prompt` 映射，断点续做（优先于新派发） |

## 配置

设置页卡片暂不可用（见下）；当前配置走 profile patch 的 entry config 或
`~/.dsh/settings.yaml` 的 `swarm:` 段：

```yaml
swarm:
  enabled: true
  announceToAgent: true
  modelMappingEnabled: false
  modelMapping:
    - type: explore
      provider: deepseek-official
      model: deepseek-v3
```

## 已知限制

- **设置页卡片受宿主白名单限制**：`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES`
  硬编码白名单，插件自注册的设置命名空间对配置客户端一律 `settings-not-exposed`
  （官方注释将「插件自声明暴露」列为 deferred work，family 插件通病）。卡片代码已
  完整实现，不可用状态下渲染为空；GUI 编辑待宿主放开后启用。
- 子 Agent 执行期间不回报中间 token（`subagents.start` 是等最终结果），进度条展示
  的是每个子 Agent 的启动/完成状态，非 token 级流式。
- 无文件锁：多子 Agent 写冲突靠任务拆分规避（与原版一致）。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（48 个用例：调度爬坡/限流/取消/超时/容量恢复 + 参数归一化 + 进度广播 + 渲染往返 + store 生命周期）
pnpm build       # lib/（host 半区）+ lib/client.js（browser 半区）
```

架构与设计细节见 [docs/architecture.md](docs/architecture.md)。

交流 / 反馈：[Issues](https://github.com/hongyue0721/dsh-kimicode-swarm/issues)
