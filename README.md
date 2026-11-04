<p align="center">
  <strong>dsh-kimicode-swarm</strong> — DeepSeek Harness 批量并行子 Agent 调度
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <img src="https://img.shields.io/badge/Host-DeepSeek%20Harness-informational?style=flat-square" alt="DeepSeek Harness" />
  <img src="https://img.shields.io/badge/Tests-159%20passed-brightgreen?style=flat-square" alt="159 unit tests" />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
</p>

<p align="center">
  <a href="./README.en.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="./assets/swarm-banner.zh.png" alt="dsh-kimicode-swarm" width="85%" />
</p>

---

把 **Kimi Code 的 Agent Swarm** 带进 DeepSeek Harness：你开启 Swarm 模式，主 Agent 把工作拆成互不依赖的子任务，一次派发最多 128 个子 Agent 并行执行，完成后汇总。每个子 Agent 在做什么，聊天里实时看得见。

<p align="center">
  <img src="./assets/swarm-card-running.light.png" alt="运行中的 Swarm 卡片：分段进度条、每个子 Agent 的工具活动、耗时和限流倒计时" width="85%" />
</p>

## 亮点

- **按子任务分配模型**：每一项都能指定模型，把贵的模型留给难的任务。
- **限流不用人管**：自动退避，接着原来的子 Agent 继续；单任务最多重试 8 次，额度耗尽时会明确失败，不会一直挂着。
- **取消不丢活**：已完成的结果模型下一轮还能看到，未完成的可按 `agent_id` 带历史续做。
- **费用你说了算**：默认只有你开启 Swarm 模式后才能派发，Agent 不能自己一次开上百个子 Agent。
- **原生界面**：分段进度条、工具活动、限流倒计时、一键进入子会话、Markdown 结果，中英文和深浅主题都跟随 DSH。
- **带上下文派发**：`fork: true` 让子 Agent 继承当前对话历史。
- **零运行时依赖**：所有依赖都由宿主提供。

## 有多快

每个任务时长固定、互相独立时，调度层相比串行的提速：

| 任务 | 宿主并发上限 | 串行 | Swarm | 提速 |
|---|---|---|---|---|
| 128 个，每个 5 分钟 | 128 | 38400 秒 | 386 秒 | **99.5 倍** |
| 128 个，每个 60 秒 | 128 | 7680 秒 | 146 秒 | 52.6 倍 |
| 20 个，每个 60 秒 | 128 | 1200 秒 | 71 秒 | 17 倍 |
| 128 个，每个 60 秒 | 8（默认） | 7680 秒 | 965 秒 | 8 倍 |

这是虚拟时钟下的调度模拟，用 `pnpm bench` 可以复现。它不含模型限流，也不代表 token 费用，实际速度取决于任务和服务商。**默认上限下最多提速 8 倍**，要跑得更快需要调大 `maxActiveSubagents`（见[配置](#配置)）。并行同样会消耗更多 token。

## 快速开始

已在 DeepSeek Harness **0.2.1-rc.5** 上验证。DSH 的插件接口还在快速变化，其他版本未经测试；0.2.0 之前的版本不支持 0.2.1。

```bash
dsh plugin --profile web add dsh-kimicode-swarm
```

也可以从 [GitHub Release](https://github.com/hongyue0721/dsh-kimicode-swarm/releases/latest) 下载 `dsh-kimicode-swarm.tgz` 安装：

```bash
dsh plugin --profile web add "file:$PWD/dsh-kimicode-swarm.tgz"
```

重启 `dsh web`，在新会话里试试：

```text
/swarm 审查 src/ 下每个模块，分别给出修复建议
```

## 使用

### Swarm 模式

| 命令 | 作用 |
|---|---|
| `/swarm` | 切换模式 |
| `/swarm on` / `/swarm off` | 持续开启 / 关闭，模式随会话保存 |
| `/swarm <任务>` | 只为这个任务开启，回合结束自动退出 |

模式开启时输入区会显示 Swarm 徽标，点一下就能关。子 Agent 不能再嵌套派发。

子 Agent 不能申请额外审批（DSH 固定其审批策略为 `never`）：超出委派权限的操作会被直接拒绝，交回父 Agent 处理，批次不会停下来等待。插件不会修改你的权限模式。

### 指定模型

优先级从高到低：单项或整批的 `model` > 配置页的映射表 > 继承调用者的模型。

```json
{ "item": "src/core/scheduler.ts", "model": "deepseek-v4-pro" }
```

### `swarm_batch` 参数

| 参数 | 说明 |
|---|---|
| `description` | 整个 swarm 的简短描述 |
| `prompt_template` | 含 `{{item}}` 占位符的提示词模板，提供 `items` 时必填 |
| `items` | 2 到 128 项（提供 `resume_agent_ids` 时可少于 2 项），`string` 或 `{ item, model?, type? }` |
| `model` | 整批模型，优先于映射表 |
| `subagent_type` | 先匹配已注册的 Agent 预设，再匹配映射表标签，都不匹配时报错；省略则继承父 Agent |
| `fork` | 继承截至上一回合的对话历史，不能与 `resume_agent_ids`、`model`、`type`、`subagent_type` 同用 |
| `resume_agent_ids` | `agent_id -> prompt` 映射，接着已有子 Agent 继续，先于新任务启动 |

`fork` 适合需要上下文的子任务，但每个子 Agent 都带着完整历史，token 消耗更高。

## 配置

模型映射、超时和并发可以在 Web 界面的「插件 → dsh-kimicode-swarm」页面修改，下一次派发立即生效。配置保存在 profile 条目中（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: dsh-kimicode-swarm
  name: dsh-kimicode-swarm
  config:
    requireSwarmMode: true      # false 时 Agent 可以自行调用
    timeoutMs: 7200000          # 单个子 Agent 超时，默认 2 小时，0 为不限
    maxConcurrency: 0           # 单批并发上限，0 为不额外限制
    modelMappingEnabled: false
    modelMapping:
      - type: explore
        provider: deepseek-official
        model: deepseek-v3
```

`enabled` 和 `announceToAgent`（默认都是 `true`）在挂载时读取，只能在这个条目里改，改完插件会重新挂载。

**想跑得更快？** 宿主默认最多同时运行 8 个子 Agent，超出的任务会排队。要提高并发，在 DSH 的「子智能体」设置页调大这个上限，或者写进 profile 的 `subagent` 条目：

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxActiveSubagents: 32
```

## 已知限制

- **需要 Web 层**：插件依赖 `webServer` 服务，在没有 web 层的 profile（如 `tui`、`headless`）中不会激活。
- **进度通道不是认证边界**：`/swarm-events` 会拒绝跨站请求，但同源客户端能收到所有会话的进度，再由界面过滤。默认只监听本机；用 `--host` 开放到局域网前请注意。
- **没有 token 级进度**：进度展示状态、工具调用次数和最近的工具名。
- **刷新后取消结果只剩文本**：已取消的批次刷新页面后不再显示状态行，结果文本仍在。
- **没有文件锁**：多个子 Agent 的写冲突靠任务拆分规避，与 Kimi Code 相同。

更多见 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test        # 159 个用例
pnpm build       # 产物在 lib/
pnpm bench       # 复现上面的调度数字
```

设计细节和与 Kimi Code 的对照见 [docs/architecture.md](docs/architecture.md)。调度算法参考了 [Kimi Code](https://github.com/MoonshotAI/kimi-code)（MIT）。

交流与反馈：[Issues](https://github.com/hongyue0721/dsh-kimicode-swarm/issues)
