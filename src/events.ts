/**
 * dsh-swarm session event: live progress snapshots of a running swarm_batch
 * call. The host half appends these while the tool executes; the browser half
 * subscribes through its own mux stream and renders per-subagent status rows.
 *
 * SessionEventMap is merge-extensible by design (see dsh-session types), so
 * the plugin owns this event type without touching the host.
 */
import type { SwarmProgressEntry } from './core/scheduler.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * One progress snapshot of a swarm_batch execution, keyed by the tool
     * call id so the UI can correlate it with the running call card. The
     * `subagents` array is a full ordered snapshot (input order), so the
     * latest event alone reconstructs the whole state.
     */
    'swarm/progress': {
      /** The owning swarm_batch tool call id (RunningToolCall.callId). */
      callId: string
      /** Per-subagent status snapshot, in input order. */
      subagents: SwarmProgressEntry[]
    }
  }
}

export type { SwarmProgressEntry }
