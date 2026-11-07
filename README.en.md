<p align="center">
  <strong>dsh-kimicode-swarm</strong> — batch parallel subagent scheduling for DeepSeek Harness
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <img src="https://img.shields.io/badge/Host-DeepSeek%20Harness-informational?style=flat-square" alt="DeepSeek Harness" />
  <img src="https://img.shields.io/badge/Tests-160%20passed-brightgreen?style=flat-square" alt="160 unit tests" />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/swarm-banner.en.png" alt="dsh-kimicode-swarm" width="85%" />
</p>

---

Inspired by **Kimi K2.5 Agent Swarm** and **Kimi Code**, this plugin brings batch-parallel subagent orchestration to DeepSeek Harness. Turn on Swarm mode and the main agent decomposes large tasks into independent work items, dispatches up to 128 subagents in parallel, and synthesizes their findings — while you watch every subagent's live progress right in the chat.

<p align="center">
  <img src="./assets/swarm-card-running.light.png" alt="A running Swarm card: segmented progress bar, each subagent's tool activity, elapsed time and rate-limit countdown" width="85%" />
</p>

## Key Features

- **Per-subtask model routing**: Assign a specific model to individual items or the entire batch so you can save frontier models for the hardest subtasks.
- **Adaptive concurrency & rate-limit recovery**: Gradual ramp-up with automatic exponential backoff and concurrency window scaling on `429` responses, resuming the same subagent once the cooldown expires (up to 8 retries per task).
- **Graceful cancellation & resume**: Stop a running batch at any time — completed subagent outputs remain available to the main agent, and unfinished subtasks can resume from where they left off via `agent_id`.
- **Opt-in dispatch control**: By default, Swarm batches only run when you enable Swarm mode via `/swarm`, keeping token usage predictable.
- **Native in-chat panel**: Segmented progress bar, live tool activity indicators, rate-limit countdowns, one-click navigation into child sessions, and collapsible Markdown results — following DSH's locale and light/dark themes.
- **Context forking**: Pass `fork: true` to start subagents with the conversation history accumulated up to the previous turn.
- **Zero runtime dependencies**: Built entirely on host-provided plugin APIs and UI primitives.

## Scheduling Performance

Theoretical scheduling speedup compared to serial execution for independent tasks of fixed duration:

| Workload | Host concurrency limit | Serial | Swarm | Speedup |
|---|---|---|---|---|
| 128 tasks, 5 minutes each | 128 | 38400 s | 386 s | **99.5x** |
| 128 tasks, 60 seconds each | 128 | 7680 s | 146 s | 52.6x |
| 20 tasks, 60 seconds each | 128 | 1200 s | 71 s | 17x |
| 128 tasks, 60 seconds each | 8 (default) | 7680 s | 965 s | 8x |

These figures come from a virtual-clock scheduler benchmark that you can reproduce with `pnpm bench`. Actual wall-clock time and token usage depend on task complexity and provider rate limits. By default, DSH runs up to 8 subagents concurrently (up to an 8x speedup); raise `maxActiveSubagents` in [Configuration](#configuration) to scale higher.

## Quick Start

Built for DeepSeek Harness **0.2.2-rc.1** (compatible with 0.2.1-rc.5; for DSH 0.1.x, install version `0.1.2` of this plugin).

```bash
dsh plugin --profile web add dsh-kimicode-swarm
```

Restart `dsh web` and run a command in a new session:

```text
/swarm Review each module under src/ and suggest fixes for each
```

## Usage

### Swarm Mode

| Command | Effect |
|---|---|
| `/swarm` | Toggle Swarm mode for the current session |
| `/swarm on` / `/swarm off` | Enable or disable persistently (saved with the session) |
| `/swarm <task>` | Enable for a single turn and exit automatically when the turn ends |

While Swarm mode is active, a Swarm badge appears in the chat input bar — click it anytime to turn the mode off. To prevent recursive fan-out, subagents cannot dispatch nested swarms.

Subagents run within the permissions delegated by the current session without pausing mid-batch for interactive approval prompts; any operation requiring elevated permissions is handed back to the main agent so the batch keeps moving.

### Model Selection

Model resolution follows this priority order (highest to lowest): explicit `model` on an item or batch > type mapping table in plugin settings > caller's current model.

```json
{ "item": "src/core/scheduler.ts", "model": "deepseek-v4-pro" }
```

### `swarm_batch` Parameters

| Parameter | Description |
|---|---|
| `description` | Brief summary of the swarm batch |
| `prompt_template` | Prompt template containing a `{{item}}` placeholder (required when `items` is provided) |
| `items` | 2 to 128 entries (fewer allowed when combined with `resume_agent_ids`), each a `string` or `{ item, model?, type? }` |
| `model` | Model override for the entire batch (takes precedence over the mapping table) |
| `subagent_type` | Matches a registered host agent preset first, then a mapping-table label; omit to inherit from the parent agent |
| `fork` | Start subagents with the conversation history up to the last completed turn (mutually exclusive with `resume_agent_ids`, `model`, `type`, and `subagent_type`) |
| `resume_agent_ids` | Map of `agent_id` to follow-up prompt to continue existing subagents, prioritized ahead of new items |

Use `fork` when subtasks depend on prior conversation context; since each forked subagent carries the full conversation history, consider context length when dispatching large batches.

## Configuration

Model mappings, timeouts, and per-batch concurrency limits can be configured in the web UI under **Plugins → dsh-kimicode-swarm** and take effect on the next dispatch. Settings are stored in your profile configuration (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: dsh-kimicode-swarm
  name: dsh-kimicode-swarm
  config:
    requireSwarmMode: true      # set false to allow the agent to dispatch without /swarm
    timeoutMs: 7200000          # per-subagent timeout (2 hours by default, 0 for no limit)
    maxConcurrency: 0           # plugin-level per-batch cap (0 for no extra limit)
    modelMappingEnabled: false
    modelMapping:
      - type: explore
        provider: deepseek-official
        model: deepseek-v3
```

`enabled` and `announceToAgent` (both `true` by default) are read when the plugin mounts; updating them in the profile configuration remounts the plugin automatically.

**Scaling concurrency**: The host activates at most 8 concurrent subagents by default and queues the rest. To increase this ceiling, adjust the limit on DSH's Subagent settings page or configure `maxActiveSubagents` on the profile's `subagent` entry:

```yaml
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxActiveSubagents: 32
```

## Usage Notes

- **Web profile**: Live progress streaming and the plugin settings panel build on the host `webServer` service and activate in the `web` profile.
- **Network access**: `/swarm-events` validates same-origin headers (`Origin` vs `Host`) and streams progress frames to connected clients, where the UI filters events by session. DSH binds to localhost by default; if you expose the server on a shared network via `--host`, place it behind an authenticating reverse proxy or access control layer.
- **Progress granularity**: Live rows display subagent lifecycle status, tool call counts, active tool names, and elapsed time; full Markdown responses render as each subagent finishes.
- **Page reload & cancellation state**: Running and completed batches restore their full interactive card across page reloads. If a batch was manually cancelled, reloading the page collapses the live status rows while preserving the collected output text.
- **Shared workspace**: Subagents work within the same workspace directory. For tasks that modify files, split items along file or module boundaries so concurrent subagents don't write to the same file simultaneously.

See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) for platform notes and version history.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # run 160 unit tests
pnpm build       # output in lib/
pnpm bench       # run the virtual-clock scheduler benchmark
```

Architecture details and a side-by-side comparison with Kimi Code are available in [docs/architecture.md](docs/architecture.md). The scheduling design draws inspiration from [Kimi Code](https://github.com/MoonshotAI/kimi-code) (MIT).

Feedback & bug reports: [Issues](https://github.com/hongyue0721/dsh-kimicode-swarm/issues)
