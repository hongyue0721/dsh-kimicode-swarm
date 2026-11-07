# awesome-dsh-plugin 收录与推荐文案

插件已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，元数据维护在该仓库的 `data/plugins/hongyue0721__dsh-kimicode-swarm.yml`（首次收录 PR：[#669](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/669)）。以下为当前版本（`v0.2.2`，160 项单测通过）的列表文案与功能简介，便于后续同步更新或社区分享。

## 列表单行简介

### English (`README.md` — Workflow & Automation)

```markdown
- [hongyue0721/dsh-kimicode-swarm](https://github.com/hongyue0721/dsh-kimicode-swarm) - Kimi K2.5 / Kimi Code inspired Agent Swarm for DSH: dispatch up to 128 parallel subagents with `/swarm` mode, per-item model routing, context forking, rate-limit backoff, and a native live progress card.
```

### 简体中文 (`README.zh.md` — 工作流与自动化)

```markdown
- [hongyue0721/dsh-kimicode-swarm](https://github.com/hongyue0721/dsh-kimicode-swarm) — 受 Kimi K2.5 与 Kimi Code 启发的 Agent Swarm 插件：支持 `/swarm` 模式、单批最多 128 个子 Agent 并行调度、按子任务分配模型、上下文 Fork、429 自动退避续做与原生聊天内实时进度面板。
```

## 版本状态与发版记录

- **当前版本**：`0.2.2`（适配 DeepSeek Harness `0.2.2-rc.1`，包含 160 个单元测试）
- **安装方式**：`dsh plugin --profile web add dsh-kimicode-swarm`
- **发布检查清单**：
  - [x] `package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`（支持 `dsh plugin add` 一键安装）
  - [x] GitHub 仓库配置 `dsh-plugin` topic
  - [x] 官方 `@deepseek-ai/*` 运行时包均声明为 `peerDependencies`，零额外运行时依赖
  - [x] npm 包已发布最新 `0.2.2` 版本，并与 GitHub Release `v0.2.2` 保持同步
