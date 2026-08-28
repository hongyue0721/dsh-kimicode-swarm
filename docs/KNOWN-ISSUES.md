# 已知问题 / Known Issues

> 维护者内部追踪文档。记录当前版本（0.1.1）已确认但尚未修复的问题，
> 以及上游 DSH SDK 接口确认情况。
>
> Internal tracking document. Lists confirmed-but-unfixed issues in the
> current release (0.1.1), plus upstream DSH SDK interface availability.

---

## 上游接口确认 / Upstream API Availability

以下问题修复所需的上游 DSH SDK 接口均已确认存在于
`@deepseek-ai/dsh-subagent@0.1.1-rc.2`，无生态阻塞。

The upstream DSH SDK interfaces required to fix the issues below are all
confirmed present in `@deepseek-ai/dsh-subagent@0.1.1-rc.2`; there are no
ecosystem blockers.

### resume / 断点续做

SDK 提供两条路径（见 `lib/types/index.d.ts` 的 `SubagentRuntime` 类）：

The SDK exposes two paths (see `SubagentRuntime` in `lib/types/index.d.ts`):

| 接口 / API | 作用 / Purpose | 文件 / File |
|---|---|---|
| `ctx.subagents.startContinuable(spec)` | 创建一个持久子 Agent，接受初始 prompt 后返回 `childId`。Establish a durable continuable child; returns `childId` after accepting the initial prompt. | `continuation.d.ts:120` |
| `ctx.subagents.followup(parent, childId, content, options)` | 向已有子 Agent 投递后续消息作为下一个 FIFO 轮次；子 Agent 不在内存时自动冷恢复。Deliver a later message to an existing child as its next FIFO turn; cold-resumes automatically when the child is absent. | `continuation.d.ts:136` |
| `ctx.agents.resume({ sessionId, ... })` | 从持久化会话冷恢复一个 Agent。Cold-resume an Agent from its persisted session. | `continuation.d.ts:327`（`coldResume` 私有方法内部使用 / used internally by `coldResume`） |

**结论**：H1 的修复路径可行——spawn 函数需按 `task.kind` 分流，
resume 任务走 `followup`（或 `agents.resume` + 投递），
新任务继续走 `start`。

**Conclusion**: H1's fix path is viable — the spawn function must branch on
`task.kind`: resume tasks go through `followup` (or `agents.resume` +
delivery), new tasks continue through `start`.

### 限流容量恢复 / Rate-limit capacity recovery

这是插件自身调度逻辑的缺失，不涉及上游接口。`SwarmScheduler` 已有
`recoveryAt` 唤醒候选和注入式时钟，只需在唤醒回调里补 `capacity += 1`。

This is a gap in the plugin's own scheduling logic, not an upstream
interface issue. `SwarmScheduler` already has the `recoveryAt` wake
candidate and an injected clock; it only needs `capacity += 1` in the
wake callback.

---

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
| H1：resume_agent_ids 断点续做不工作 / resume not wired | ✅ 已修复 | 0.1.2 |
| H2：限流容量恢复未实现 / capacity recovery missing | ✅ 已修复 | 0.1.2 |
| M1：progress store 内存泄漏 / dropSwarmProgress never called | ✅ 已修复 | 0.1.2 |
| M2：settle 后丢失 type/model 列 / settled rows lose type/model | ✅ 已修复 | 0.1.2 |
| M3：spawn 抛错时状态标记错误 / wrong state on spawn throw | ✅ 已修复 | 0.1.2 |
| M4：定时器未 unref / timers not unref'd | ✅ 已修复 | 0.1.2 |
| L1：EventSource 无错误处理 / no EventSource error handler | ✅ 已修复 | 0.1.2 |
| L2：容量种子高估 / capacity seed overcounts | ✅ 已修复 | 0.1.2 |
| L3：resume-only 计数显示 undefined / resume-only count undefined | ✅ 已修复 | 0.1.2 |
| issue #1：`agentOptions.provider` 显式 undefined 覆盖继承 provider | ⏳ 等待外部 PR | — |
| Issue #1: `agentOptions.provider` explicit undefined overwrites inherited provider | Awaiting external PR | — |

---

## 测试缺口 / Test Coverage Gaps

0.1.2 版本新增了 `tests/render.spec.ts`（renderSwarmResults XML 往返，
覆盖 M2/H1 渲染）和 `tests/progress-store.spec.ts`（store 生命周期，覆盖
M1），并扩展了 `tests/scheduler.spec.ts`（容量恢复 H2、catch 状态 M3、
容量种子 L2）。以下路径仍无测试覆盖：

Version 0.1.2 added `tests/render.spec.ts` (renderSwarmResults XML round-trip,
covering M2/H1 rendering) and `tests/progress-store.spec.ts` (store lifecycle,
covering M1), and extended `tests/scheduler.spec.ts` (capacity recovery H2,
catch state M3, capacity seed L2). These paths remain untested:

- **`src/index.ts` 宿主层**：spawn 的 resume 路径（H1，`followup` +
  `subagent/end` 事件监听）需要 mock `ctx.subagents`；`/swarm` 命令、SSE
  路由处理器、`isRateLimitError` 启发式仍无直接测试。
- **调度器**：收缩间隔节流、cancel-mid-flight、`maxConcurrency` × 限流
  交互。
- **normalize**：模板多次占位符、item 值含 `{{item}}`、resume 非对象值、
  跨种类去重。
- **客户端组件**：`SwarmCard` 和 `SwarmSettingsCard` 需 React 测试环境
  （`parseArgs` L3 修复通过推理验证，无组件级测试）。