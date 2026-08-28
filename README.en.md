<p align="center">
  <strong>dsh-kimicode-swarm</strong> — batch parallel subagent scheduling for DeepSeek Harness
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square" alt="dsh-plugin" /></a>
  <img src="https://img.shields.io/badge/Host-DeepSeek%20Harness-informational?style=flat-square" alt="DeepSeek Harness" />
  <img src="https://img.shields.io/badge/Tests-48%20passed-brightgreen?style=flat-square" alt="48 unit tests" />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
</p>

---

A port of **Kimi Code Swarm mode** (master/worker parallel multi-agent) into DeepSeek Harness:
the main agent splits a task into independent subtasks, `swarm_batch` dispatches them in one
batch, the subagents run in parallel, and the results are aggregated — up to **4.5x end-to-end
efficiency gain** in the official benchmarks. **In-chat live progress rows**: one status line per
subagent (queued / running / completed), lighting up one by one like Kimi's TUI.

## Features

- **`swarm_batch` tool**: `prompt_template` + `items` generate subtasks in bulk (up to 128
  items), each item may carry its own `model` / `type`; `resume_agent_ids` resumes unfinished
  work.
- **Adaptive scheduling** (aligned with the Kimi SubagentBatch contract): 5 concurrent launches
  up front, then +1 every 700ms; exponential backoff on rate limits (3s/6s/12s…) with adaptive
  capacity shrink/recovery; user cancellation preserves completed results; a per-task timeout
  fails only that task.
- **`/swarm <task>` command**: one-shot Swarm mode — explore the task boundary, split it into
  subtasks, dispatch the batch, summarize, and exit the mode automatically (mirrors Kimi's
  task-triggered semantics).
- **In-chat live progress**: the host broadcasts full-snapshot progress frames over an SSE
  route (`/swarm-events`); the browser subscribes via a same-origin EventSource and renders
  per-subagent status rows — pulsing blue dot while running, gray while queued, green when done.
- **Three-level model assignment**: per-item / batch explicit `model` > settings mapping table
  (matched by type) > inherit the caller's model (default, left to the agent).

## Architecture

```
┌─ host half (node process, src/index.ts) ────────────────────────┐
│  swarm_batch tool (ctx.tools.register)                           │
│    ├─ argument normalization (core/normalize.ts): template fill │
│    │   / model resolution / dedup                                │
│    ├─ SwarmScheduler (core/scheduler.ts): two-phase adaptive     │
│    │   concurrency                                               │
│    │    └─ onProgress callback: full snapshot per status change │
│    ├─ ctx.subagents.start(): real subagent launch (inherits the │
│    │   caller's model when none is resolved)                     │
│    └─ progress.ts: createProgressBroadcaster → SSE frames on     │
│        /swarm-events (SWARM_PROGRESS_ROUTE)                      │
│  /swarm command (ctx.commands.register): one-shot swarm mode     │
│  settings namespace + system-prompt announcement                 │
└──────────────────────────────────────────────────────────────────┘
                            │ SSE (event: progress, JSON snapshot)
┌─ browser half (Web GUI, src/client/) ──────────────────────────┐
│  index.ts: same-origin EventSource on /swarm-events             │
│  progress-store.ts: module-level store, snapshots keyed by      │
│    callId                                                        │
│  SwarmCard.tsx: tool.call.toolview keyed view                    │
│    ├─ running: one live status row per subagent                  │
│    │   (queued/running/completed)                                │
│    └─ settled: results panel (expandable rows, from             │
│        presentationMeta)                                         │
│  SwarmSettingsCard.tsx: settings card (model mapping table,      │
│    model catalog pulled live)                                    │
└──────────────────────────────────────────────────────────────────┘
```

Key design decisions:

- **Scheduler decoupled from the runtime**: `core/` is pure logic (SpawnFn and a clock are
  injected; tests drive it with fakes) and does not depend on host types (framework-free, in
  the style of dsh-task-board).
- **Progress rides a dedicated SSE route, not session events**: rc.8 rejects
  out-of-vocabulary session events on read, so `swarm/progress` can no longer ride the session
  log. Progress is display-only: the host broadcasts full-snapshot frames over `/swarm-events`
  and the browser subscribes with a same-origin EventSource — zero host changes, and the
  session log stays clean.
- **Model assignment defaults back to the LLM**: omit `model` to inherit the caller's model
  and let the agent assign per difficulty; an explicit model always wins.

## Install

Published to **npm** (`dsh-kimicode-swarm`) — one line into any DSH profile:

```bash
dsh plugin --profile web add dsh-kimicode-swarm
# equivalent to:
pnpm add dsh-kimicode-swarm
```

Or install from GitHub / locally:

```bash
pnpm add github:hongyue0721/dsh-kimicode-swarm   # or
pnpm add file:/path/to/dsh-kimicode-swarm
```

Restart `dsh web` after installing; the `swarm_batch` tool and `/swarm` command appear in
**new sessions**.

## Usage

**Let the agent work**: just describe the task — the agent decides whether a parallel batch is
worth it; or explicitly ask to "dispatch with swarm".

**Quick command**:

```
/swarm review these three modules and suggest fixes
```

**Model assignment**: by default subagents inherit the caller's model; to pin a model per
task, write `{ "item": "...", "model": "deepseek-v4-pro" }` for an item, or pass a batch-level
`model` field.

**`swarm_batch` parameters** (model-facing contract):

| Parameter | Description |
|---|---|
| `description` | Short description of the whole swarm (required) |
| `subagent_type` | Subagent type for new spawns (default `coder`) |
| `model` | Batch-level model override (takes precedence over the mapping table) |
| `prompt_template` | Required when `items` is given; must contain the `{{item}}` placeholder |
| `items` | 2..128 entries; `string` or `{ item, model?, type? }` |
| `resume_agent_ids` | `agent_id -> prompt` map for resuming unfinished work (launched before new spawns) |

## Configuration

The settings-page card is currently unavailable (see below); configure via the profile
patch's entry config or the `swarm:` section of `~/.dsh/settings.yaml`:

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

## Known limitations

- **Settings card blocked by the host whitelist**: `dsh-host-apiproxy` hard-codes
  `WEB_SETTINGS_NAMESPACES`; a plugin-registered settings namespace is always
  `settings-not-exposed` to the config client (the official notes list "plugin-declared
  exposure" as deferred work — a known family-wide issue). The card code is complete and
  renders nothing in the unavailable state; GUI editing will be enabled once the host opens
  up.
- Subagents do not stream intermediate tokens while running (`subagents.start` resolves with
  the final result); the progress rows show each subagent's launch/settle status, not
  token-level streaming.
- No file locking: multi-subagent write conflicts are avoided by task decomposition (same as
  the original).

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (48 tests: scheduler ramp/rate-limit/cancel/timeout/capacity-recovery + normalization + progress + render round-trip + store lifecycle)
pnpm build       # lib/ (host half) + lib/client.js (browser half)
```

Architecture and design details: [docs/architecture.md](docs/architecture.md).

Feedback / issues: [Issues](https://github.com/hongyue0721/dsh-kimicode-swarm/issues)

## License

[MIT](./LICENSE)
