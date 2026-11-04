/**
 * Keeps the browser subscribed to the host's progress route. EventSource
 * reconnects by itself after a dropped connection (readyState CONNECTING) but
 * gives up for good on an HTTP error (readyState CLOSED), which is what a
 * restarting host answers until its routes register. Only that case needs a
 * new EventSource; the host replays running calls to every new connection.
 */
import type { SwarmProgressEntry } from '../core/scheduler.ts'
import { clearSwarmModes, dropSwarmProgress, publishSwarmProgress, publishSwarmMode, SWARM_PROGRESS_ROUTE, type ClientSwarmMode } from './progress-store.ts'

/** EventSource.CLOSED; spelled out because the constant is absent outside browsers. */
const EVENT_SOURCE_CLOSED = 2

const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 60_000

/** The EventSource constructor, injectable for tests. */
export type EventSourceFactory = (url: string) => EventSource

/**
 * Open the stream and keep it open.
 * @param create - builds one EventSource.
 * @returns the disposer closing the stream and any pending reconnect.
 */
export function openProgressStream(
  create: EventSourceFactory = (url) => new EventSource(url),
): () => void {
  let source: EventSource | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = RECONNECT_BASE_MS
  let disposed = false

  const connect = (): void => {
    const current = create(SWARM_PROGRESS_ROUTE)
    source = current
    current.onopen = () => {
      delay = RECONNECT_BASE_MS
      clearSwarmModes()
    }
    current.addEventListener('progress', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent).data) as {
          callId: string
          sessionId: string
          subagents: SwarmProgressEntry[]
        }
        if (typeof frame.sessionId !== 'string' || typeof frame.callId !== 'string' || !Array.isArray(frame.subagents)) return
        publishSwarmProgress(frame.callId, frame.subagents, frame.sessionId)
      } catch {
        // Malformed frames are dropped; the next frame overwrites the store.
      }
    })
    current.addEventListener('mode', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent).data) as ClientSwarmMode
        if (typeof frame.sessionId !== 'string' || typeof frame.active !== 'boolean' ||
            !['manual', 'task', null].includes(frame.trigger) || frame.active !== (frame.trigger !== null)) return
        publishSwarmMode(frame)
      } catch {
        // Transport corruption is not a mode change; reconnect replays active modes.
      }
    })
    current.addEventListener('progress-end', (event) => {
      try {
        const frame = JSON.parse((event as MessageEvent).data) as { callId: string; sessionId: string }
        if (typeof frame.callId === 'string' && typeof frame.sessionId === 'string') dropSwarmProgress(frame.callId, frame.sessionId)
      } catch {
        // A malformed end record only delays cleanup until the card settles.
      }
    })
    current.onerror = () => {
      if (disposed || current.readyState !== EVENT_SOURCE_CLOSED) return
      timer = setTimeout(connect, delay)
      delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }
  }
  connect()

  return () => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    source?.close()
  }
}
