/**
 * Host-side live progress broadcaster for running swarm_batch calls.
 *
 * rc.8 session logs refuse out-of-vocabulary event types (the swarm/progress
 * session event is not part of the harness vocabulary and append() cannot
 * mark it ignorable), so progress snapshots can no longer ride session
 * events. They are live-only data: this module owns the per-call snapshot
 * store and the SSE frame writer. The webServer route adapter lives in the
 * host entry; the core stays testable without a real HTTP server.
 */
import type { ServerResponse } from 'node:http'
import type { SwarmProgressEntry } from './core/scheduler.ts'

/** One progress snapshot broadcast to subscribed browser halves. */
export interface SwarmProgressFrame {
  callId: string
  subagents: SwarmProgressEntry[]
}

/** The route serving progress streams; the browser half connects here. */
export const SWARM_PROGRESS_ROUTE = '/swarm-events'

/** SSE event name for progress frames (EventSource dispatches on it). */
export const SWARM_PROGRESS_EVENT = 'progress'

/** Frame serialized to one SSE record: `event: progress` + JSON data. */
export function serializeFrame(frame: SwarmProgressFrame): string {
  const data = JSON.stringify(frame)
  return `event: ${SWARM_PROGRESS_EVENT}\ndata: ${data}\n\n`
}

/** Heartbeat record; proxies drop idle SSE connections without it. */
export function serializeHeartbeat(): string {
  return 'event: ping\ndata: {}\n\n'
}

export interface ProgressBroadcaster {
  /** Attach one SSE response; returns the detach disposer. */
  subscribe(response: ServerResponse): () => void
  /** Push one snapshot to every attached response. */
  publish(frame: SwarmProgressFrame): void
  /** Stop heartbeats and drop every attachment (plugin teardown). */
  close(): void
}

/** Write one record to a live SSE response; false when the socket is gone. */
function writeRecord(response: ServerResponse, record: string): boolean {
  if (response.destroyed || response.writableEnded) return false
  try {
    response.write(record)
    return true
  } catch {
    return false
  }
}

/**
 * Create a broadcaster. One shared heartbeat timer walks all attachments,
 * so N connections cost one interval. Failed writes detach the response.
 */
export function createProgressBroadcaster(heartbeatMs = 15000): ProgressBroadcaster {
  const attachments = new Set<ServerResponse>()
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const pruneDead = (): void => {
    for (const response of attachments) {
      if (response.destroyed || response.writableEnded) attachments.delete(response)
    }
  }

  const beat = (): void => {
    pruneDead()
    for (const response of attachments) {
      if (!writeRecord(response, serializeHeartbeat())) attachments.delete(response)
    }
  }

  timer = setInterval(beat, heartbeatMs)
  // Keep the process alive while any stream is attached (SSE holds the loop).
  timer.unref?.()

  return {
    subscribe(response) {
      attachments.add(response)
      return () => {
        attachments.delete(response)
      }
    },
    publish(frame) {
      pruneDead()
      const record = serializeFrame(frame)
      for (const response of attachments) {
        if (!writeRecord(response, record)) attachments.delete(response)
      }
    },
    close() {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      attachments.clear()
    },
  }
}
