/**
 * Host-side live progress broadcaster for running swarm_batch calls.
 *
 * High-volume display snapshots stay outside the durable session log. Mode
 * authorization uses separate ignorable plugin records; progress is live-only
 * and replays from this broadcaster while the call is still running.
 */
import type { ServerResponse } from 'node:http'
import type { SwarmProgressEntry } from './core/scheduler.ts'

/** One progress snapshot broadcast to subscribed browser halves. */
export interface SwarmProgressFrame {
  sessionId: string
  callId: string
  subagents: SwarmProgressEntry[]
}

export interface SwarmModeFrame {
  sessionId: string
  active: boolean
  trigger: 'manual' | 'task' | null
}

/** The route serving progress streams; the browser half connects here. */
export const SWARM_PROGRESS_ROUTE = '/swarm-events'

/** SSE event name for progress frames (EventSource dispatches on it). */
export const SWARM_PROGRESS_EVENT = 'progress'

/** SSE event name announcing that a call finished and its snapshot is spent. */
export const SWARM_PROGRESS_END_EVENT = 'progress-end'

/** Frame serialized to one SSE record: `event: progress` + JSON data. */
export function serializeFrame(frame: SwarmProgressFrame): string {
  const data = JSON.stringify({ ...frame, subagents: frame.subagents.map((entry) => ({
    ...entry, item: entry.item === null ? null : Array.from(entry.item).slice(0, 200).join(''),
  })) })
  return `event: ${SWARM_PROGRESS_EVENT}\ndata: ${data}\n\n`
}

export function serializeMode(frame: SwarmModeFrame): string {
  return `event: mode\ndata: ${JSON.stringify(frame)}\n\n`
}

/** Record telling browser halves to release one finished call's snapshot. */
export function serializeEnd(callId: string, sessionId: string): string {
  return `event: ${SWARM_PROGRESS_END_EVENT}\ndata: ${JSON.stringify({ callId, sessionId })}\n\n`
}

/** Heartbeat record; proxies drop idle SSE connections without it. */
export function serializeHeartbeat(): string {
  return 'event: ping\ndata: {}\n\n'
}

export interface ProgressBroadcaster {
  /** Attach one SSE response, replaying running calls; returns the detach disposer. */
  subscribe(response: ServerResponse): () => void
  /** Push one snapshot to every attached response. */
  publish(frame: SwarmProgressFrame): void
  /** Forget one finished call and tell every attached response to release it. */
  finish(callId: string, sessionId: string): void
  mode(frame: SwarmModeFrame): void
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
  const frameKey = (callId: string, sessionId: string): string => JSON.stringify([sessionId, callId])
  const attachments = new Set<ServerResponse>()
  /** Latest frame of each running call, replayed to late or reconnecting streams. */
  const running = new Map<string, SwarmProgressFrame>()
  const modes = new Map<string, SwarmModeFrame>()
  const lastSent = new Map<string, number>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const pruneDead = (): void => {
    for (const response of attachments) {
      if (response.destroyed || response.writableEnded) attachments.delete(response)
    }
  }

  const writeToAll = (record: string): void => {
    pruneDead()
    for (const response of attachments) {
      if (!writeRecord(response, record)) attachments.delete(response)
    }
  }

  const beat = (): void => {
    writeToAll(serializeHeartbeat())
  }

  const flush = (callId: string): void => {
    const timer = pending.get(callId)
    if (timer !== undefined) clearTimeout(timer)
    pending.delete(callId)
    const frame = running.get(callId)
    if (frame === undefined) return
    lastSent.set(callId, Date.now())
    writeToAll(serializeFrame(frame))
  }

  timer = setInterval(beat, heartbeatMs)
  // Keep the process alive while any stream is attached (SSE holds the loop).
  timer.unref?.()

  return {
    subscribe(response) {
      attachments.add(response)
      for (const frame of running.values()) writeRecord(response, serializeFrame(frame))
      for (const frame of modes.values()) writeRecord(response, serializeMode(frame))
      return () => {
        attachments.delete(response)
      }
    },
    publish(frame) {
      if (closed) return
      const key = frameKey(frame.callId, frame.sessionId)
      const previous = running.get(key)
      running.set(key, frame)
      const terminal = frame.subagents.some((entry, index) =>
        ['completed', 'failed', 'aborted'].includes(entry.status) && previous?.subagents[index]?.status !== entry.status,
      )
      const elapsed = Date.now() - (lastSent.get(key) ?? Number.NEGATIVE_INFINITY)
      if (terminal || elapsed >= 250) flush(key)
      else if (!pending.has(key)) {
        const timer = setTimeout(() => flush(key), 250 - elapsed)
        timer.unref?.()
        pending.set(key, timer)
      }
    },
    finish(callId, sessionId) {
      const key = frameKey(callId, sessionId)
      if (pending.has(key)) flush(key)
      running.delete(key)
      lastSent.delete(key)
      writeToAll(serializeEnd(callId, sessionId))
    },
    mode(frame) {
      if (closed) return
      const previous = modes.get(frame.sessionId)
      if (previous?.active === frame.active && previous.trigger === frame.trigger) return
      if (frame.active) modes.set(frame.sessionId, frame)
      else modes.delete(frame.sessionId)
      writeToAll(serializeMode(frame))
    },
    close() {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      attachments.clear()
      running.clear()
      modes.clear()
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      lastSent.clear()
    },
  }
}
