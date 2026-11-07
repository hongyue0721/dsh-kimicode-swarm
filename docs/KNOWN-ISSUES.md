# 已知问题 / Known Issues

> 维护者内部追踪文档。下方「待修复」是当前版本已确认但尚未修复的问题；
> 「历史问题」保留 0.1.x 的分析记录，其中的 API 与行号对应当时的 SDK（0.1.1-rc.2）。
>
> Internal tracking document. "Open" lists confirmed-but-unfixed issues in the
> current code; "Historical" keeps the 0.1.x analysis, whose APIs and line
> numbers refer to the SDK of that time (0.1.1-rc.2).

---

## 待修复 / Open

基于 DSH 0.2.2-rc.1。

### O10：SSE 仍不提供身份与服务端会话授权

已增加 Origin host 检查和客户端 sessionId 过滤，但所有获准连接仍能收到全部会话快照。
无 Origin 的非浏览器请求也能连接。这不是认证；对外部署需要宿主之外的访问控制，不能把 UI 过滤当成数据隔离。

### O11：尚未实机验证的路径

真实服务商的 429 与容量恢复、超时触发、128 项规模、`/swarm-events` 断线重连。这些只有单元测试。
客户端单测使用平台替身，只验证交互和传参，已实机验证的范围见 `docs/architecture.md` 第 7 节。

### O12：刷新后的取消状态不持久化

取消调用没有最终 presentationMeta，进度又是内存快照。刷新后只能在默认折叠的“原始结果”中查看 XML，
不能恢复逐项状态行；这是当前设计边界，不伪造缺失的状态。

### O9：已关闭的设计差异

- 显式 `subagent_type` 先选择注册预设，映射表标签不改变能力；未知类型明确报错。
- 限流容量改为成功发布数减一，未发布限流增加全局等待，进入限流模式后不退出。
- SSE 增加 Origin 检查及父会话字段；剩余认证边界单独记录为 O10。
- 取消 XML 默认折叠，刷新后的状态行限制单独记录为 O12。

---

## 已修复 / Fixed (rc.5 迁移之后)

| 问题 | 根因 | 修复 |
|---|---|---|
| O9 模式、预设、调度与展示差异 | 旧行为缺少用户门槛，预设仅作标签 | Swarm v2 模式、fork、预设解析、调度对齐和原生界面 |
| O1 爬坡在第 6 个任务后停止 | 启动任务后未重新安排唤醒 | 重写唤醒逻辑，启动后总是安排下一次 |
| O2 超过宿主上限时任务失败 | 未识别 `ACTIVATION_LIMIT_REACHED` | 任务排回队列，下一个任务结束时再试；没有运行中的任务时定时重试 |
| O3 `wakeAt` 忙等、定时器泄漏 | 未排队的 `eligibleAt` 为 0 被当作唤醒点；旧定时器未清除 | 只保留一个定时器，按实际下一个时刻设置 |
| O4 模型限流不触发退避 | 限流以 `stopReason: 'error'` 返回，且曾靠文本匹配判断 | 监听 `agent/request-error`，按 `failure.code` 判断，并把错误详情写入结果 |
| O5 持续限流时批次不结束 | 无重试上限 | 单任务最多重试 8 次（`maxRateLimitRetries`），这是与 Kimi 的有意差异 |
| O6 取消后无法续做、结果不可见 | 子 Agent id 未及时上报；取消后宿主丢弃返回值 | 发布时上报 id；取消时以抛错交付结果，模型下一轮可见 |
| O7 `EventSource` 出错后永久关闭 | 瞬断也会 `close()` | 瞬断交给浏览器重连，彻底关闭时退避重开；服务端向新连接补发运行中的快照 |
| O8 结果 XML 正文未转义 | 展示数据从 XML 反解析 | 工具值改为结构化，展示数据直接投影；模型文本只中和封套标签 |
| 超时、并发配置未生效 | 宿主未传入 | 新增配置 `timeoutMs`（默认 2 小时）、`maxConcurrency` |
| 未挂载卡片的快照不清理 | 只由卡片负责清理 | 调用结束时服务端发送 `progress-end` |
| 失败未启动的任务无法处理 | 提示只讲续做 | 结果增加 `<restart_hint>` |

---

# 历史问题 / Historical (0.1.x)

## 高危 / High Severity

### H1：`resume_agent_ids` 断点续做实际不工作

**文件**: `src/index.ts:332-343`

`spawn` 函数永远调用 `ctx.subagents.start()`——创建一个全新的一次性子
Agent。它从不读取 `task.resumeAgentId` 或 `task.kind`，因此 resume 任务
携带的 `agent_id` 被丢弃，子 Agent 从零开始，没有任何历史会话状态。

README、`SWARM_GUIDANCE` 和 `<resume_hint>` 都宣传了"断点续做"功能，
但实际从未通过宿主层实现。

**影响**: 用户使用 `resume_agent_ids` 时，期望子 Agent 接着上次的状态
继续，实际是完全重新开始——行为与预期不符且不报错。

**修复方案**: 在 `spawn` 中按 `task.kind === 'resume'` 分流：resume
任务走 `ctx.subagents.followup(parent, task.resumeAgentId, prompt, ...)`
（子 Agent 不在内存时 SDK 自动冷恢复），新任务继续走 `start`。需处理
`followup` 不返回 `SubagentRun` 的差异——它返回的是 `MessageId`，结果
需要通过 `subagent/end` 事件或轮询子 Agent 状态获取。

The `spawn` function always calls `ctx.subagents.start()`, which creates a
brand-new one-shot child. It never reads `task.resumeAgentId` or
`task.kind`, so the `agent_id` carried by resume tasks is discarded and
the child starts from scratch with no prior session state.

The README, `SWARM_GUIDANCE`, and `<resume_hint>` all advertise
"resume" functionality, but it was never wired through the host layer.

**Fix**: Branch in `spawn` on `task.kind === 'resume'`: resume tasks go
through `ctx.subagents.followup(parent, task.resumeAgentId, prompt, ...)`
(the SDK cold-resumes automatically when the child is absent), new tasks
continue through `start`. Note that `followup` returns a `MessageId` rather
than a `SubagentRun` — the result must be obtained via the `subagent/end`
event or by polling the child agent's status.

### H2：限流后容量恢复未实现

**文件**: `src/core/scheduler.ts:276-287, 311-320`

代码计算了 `recoveryAt`（限流后 3 分钟恢复窗口）并将其作为唤醒候选，
模块文档和 README 都承诺"3 分钟后容量恢复 +1"。但唤醒后 `schedule()`
只检查 `active.size >= capacity`，**没有任何代码将 `capacity` 递增**。
`capacity` 只有两个赋值点：初始化（138 行）和限流收缩（270 行
`Math.max(1, capacity - 1)`）。一旦早期撞限流导致容量收缩，整批任务
都会以收缩后的低并发跑完，永远不恢复。

**影响**: 早期撞一次限流的批次，后续全程低并发，白白浪费时间。

**修复方案**: 在 `schedule()` 唤醒到 `recoveryAt` 时执行
`capacity += 1` 并重置 `lastRateLimitAt = now`；容量恢复到自然上限后
退出限流模式。

The code computes `recoveryAt` (a 3-minute quiet window after rate
limiting) and uses it as a wake candidate, and both the module docstring
and README promise "capacity recovers +1 after 3 minutes." But on wake,
`schedule()` only checks `active.size >= capacity` — **no code ever
increments `capacity`**. It has only two assignment sites: initialization
(line 138) and rate-limit shrink (line 270, `Math.max(1, capacity - 1)`).
Once an early rate limit shrinks capacity, the entire batch runs at the
reduced concurrency and never recovers.

**Fix**: In `schedule()`, when waking at `recoveryAt`, do `capacity += 1`
and reset `lastRateLimitAt = now`; exit rate-limit mode once capacity
returns to its natural ceiling.

---

## 中危 / Medium Severity

### M1：客户端 progress store 内存泄漏

**文件**: `src/client/progress-store.ts:38`

`dropSwarmProgress(callId)` 已导出但从未被调用。每个 `swarm_batch` 调用
的进度快照（最多 128 条）在单例 store 中堆积，长会话下不释放。

**修复方案**: `SwarmCard` 在 `settled` 变为 true 时调用
`dropSwarmProgress(block.callId)`。

`dropSwarmProgress(callId)` is exported but never called. Each
`swarm_batch` call's progress snapshots (up to 128 entries) accumulate in
the singleton store and are never released across a long session.

**Fix**: In `SwarmCard`, call `dropSwarmProgress(block.callId)` when
`settled` becomes true.

### M2：settle 后进度卡片丢失 type/model 列

**文件**: `src/index.ts:110-140`（`renderSwarmResults`）, `src/index.ts:393-410`（`parseResultsXml`）

`renderSwarmResults` 渲染 `<subagent>` 标签时不输出 `type=`/`model=`/`mode=`
属性，`parseResultsXml` 解析时又将这些字段硬编码为 `undefined`。运行中
进度卡片能正确显示 type/model 徽章（来自调度器的 progress 快照），
但任务完成后 UI 切换到 `presentationMeta` 渲染路径，这些列变空白；
resume 类型的任务还会被误标为 `spawn`。

**修复方案**: `renderSwarmResults` 输出 `type`/`model`/`mode` 属性，
`parseResultsXml` 读取它们；或直接将结构化结果传入 `presentationMeta`
而非 XML 往返。

`renderSwarmResults` omits `type=`/`model=`/`mode=` attributes on
`<subagent>` tags, and `parseResultsXml` hardcodes those fields to
`undefined`. While running, the card shows correct type/model badges (from
the scheduler's progress snapshots), but after settlement the UI switches
to the `presentationMeta` render path and those columns go blank; resume
tasks are also mislabeled as `spawn`.

**Fix**: Have `renderSwarmResults` emit `type`/`model`/`mode` attributes
and `parseResultsXml` read them; or pass structured results directly into
`presentationMeta` instead of the XML round-trip.

### M3：spawn 同步抛错时状态标记错误

**文件**: `src/core/scheduler.ts:411-417`

`runAttempt` 的 catch 块对从未启动的任务也标记 `state: 'started'`，
与宿主 `spawn`（`src/index.ts:353-362`）自己正确返回的 `not_started`
矛盾。影响取消态统计（`aborted/started` vs `aborted/not_started`）。

**修复方案**: catch 中按 `slot.agentId !== undefined` 判断——有 agentId
才是 `started`，否则 `not_started`。

`runAttempt`'s catch block marks tasks `state: 'started'` even when the
spawn never started, contradicting the host `spawn`'s own correct
`not_started` return. This affects cancellation accounting
(`aborted/started` vs `aborted/not_started`).

**Fix**: In the catch, use `slot.agentId !== undefined` to decide —
`started` only when an agentId exists, otherwise `not_started`.

### M4：调度器定时器未 unref

**文件**: `src/core/scheduler.ts:89`（注入的 `setTimeout`）, `:357`（`wakeTimer`）, `:393`（per-task timeout timer）

与 progress 心跳（`src/progress.ts:81` 调了 `timer.unref?.()`）不同，
调度器的超时定时器和唤醒定时器没有 unref。长超时 + 挂起子 Agent 可能
阻止 Node 进程正常退出。

**修复方案**: 对注入的 `setTimeout` 返回的句柄调用 `.unref?.()`。

Unlike the progress heartbeat (`src/progress.ts:81` calls
`timer.unref?.()`), the scheduler's per-task timeout and wake timers are
not unref'd. A long timeout with a hung subagent can keep the Node process
alive past shutdown.

**Fix**: Call `.unref?.()` on the timer handles returned by the injected
`setTimeout`.

---

## 低危 / Low Severity

### L1：EventSource 无错误处理

**文件**: `src/client/index.ts:51-63`

浏览器端 `EventSource` 只挂了 `progress` 监听器，没有 `onerror`。宿主未
开 web 服务或路由未注册时，EventSource 静默重连，用户无法区分"暂无进度"
和"配置错误"。

**修复方案**: 添加 `source.onerror` 处理（至少静默吞掉，或记录一次日志）。

The browser `EventSource` has only a `progress` listener, no `onerror`.
When the host has no web server or the route is unregistered, EventSource
reconnects silently and the user cannot distinguish "no progress yet"
from "misconfigured host."

**Fix**: Add an `onerror` handler (at minimum swallow silently, or log once).

### L2：限流容量种子高估

**文件**: `src/core/scheduler.ts:262`

`enterRateLimitMode` 用 `normalLaunches`（累计启动次数，含限流重试）作为
capacity 种子，而非实际并发就绪任务数。首次限流时 capacity 可能高估。
`min(count)` 限制有部分兜底。

**修复方案**: 用 `active.size + ready.size` 或独立的"已启动去重计数"
作为种子。

`enterRateLimitMode` seeds capacity from `normalLaunches` (cumulative
launch count, including rate-limited retries) rather than actual
concurrent ready tasks. The initial capacity on first rate-limit may be
overstated. The `min(count)` clamp partly mitigates this.

**Fix**: Seed from `active.size + ready.size` or a separate
distinct-launched count.

### L3：resume-only 批次计数显示 undefined

**文件**: `src/client/SwarmCard.tsx:58-65, 154`

运行中头部显示 `{args.count} 项`，取自 `parsed.items?.length`。纯 resume
批次（无 `items`）显示 `undefined 项`。

**修复方案**: 计数改为
`Object.keys(args.resume_agent_ids).length + (items?.length ?? 0)`。

The running header shows `{args.count} 项` from `parsed.items?.length`.
A resume-only batch (no `items`) shows `undefined 项`.

**Fix**: Count as
`Object.keys(args.resume_agent_ids).length + (items?.length ?? 0)`.

---

## 已处理 / Resolved

| 问题 / Issue | 状态 / Status | 版本 / Version |
|---|---|---|
| 文档过期（会话事件描述、测试数 21→30、items 范围） | ✅ 已修复 | 0.1.1 |
| Stale docs (session-event description, test count 21→30, items range) | Fixed | 0.1.1 |
| 依赖版本未适配 rc.2 / SDK version mismatch | ✅ 已升级 | 0.1.1 |
| H1：resume_agent_ids 断点续做不工作 / resume not wired | ✅ 随 rc.5 迁移修复（0.1.2 的 `followup` 对 `start()` 启动的一次性子 Agent 仍会被拒绝） | 迁移版本 |
| H2：限流容量恢复未实现 / capacity recovery missing | ✅ 已修复 | 0.1.2 |
| M1：progress store 内存泄漏 / dropSwarmProgress never called | ✅ 已修复 | 0.1.2 |
| M2：settle 后丢失 type/model 列 / settled rows lose type/model | ✅ 已修复 | 0.1.2 |
| M3：spawn 抛错时状态标记错误 / wrong state on spawn throw | ✅ 已修复 | 0.1.2 |
| M4：定时器未 unref / timers not unref'd | ✅ 已修复 | 0.1.2 |
| L1：EventSource 无错误处理 / no EventSource error handler | ✅ 已修复 | 0.1.2 |
| L2：容量种子高估 / capacity seed overcounts | ✅ 已修复 | 0.1.2 |
| L3：resume-only 计数显示 undefined / resume-only count undefined | ✅ 已修复 | 0.1.2 |
| issue #1：`agentOptions.provider` 显式 undefined 覆盖继承 provider | ✅ 已修复（PR #4） | 0.1.2 |
| Issue #1: `agentOptions.provider` explicit undefined overwrites inherited provider | Fixed (PR #4) | 0.1.2 |

---

## 测试与验收缺口

当前 160 个单元测试覆盖模式命令/恢复/子会话拒绝、fork 全部互斥参数、预设四条解析规则、独占元数据、
成功发布容量和全局退避、进度字段/节流/终态立即发送、模式补发、Origin、客户端会话隔离与交互。

原生组件及 store 的替身单测不会证明宿主 CSS、Tooltip 定位、Markdown 排版或侧栏导航正确。
历史的真实模型运行记录不属于本次验证，本次未使用真实 API key 或付费服务。
