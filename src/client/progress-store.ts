/**
 * Module-level progress store for running swarm_batch calls. The browser
 * half's apply() opens an EventSource to the host /swarm-events route and
 * publishes every progress frame here; SwarmCard components subscribe by
 * call id. Module scope is fine: the client bundle is a singleton per page.
 */
import type { SwarmProgressEntry } from '../core/scheduler.ts'

/** The host route serving progress frames (same-origin relative URL). */
export const SWARM_PROGRESS_ROUTE = '/swarm-events'

/** One subscribed component's change listener. */
type Listener = (callId: string, entries: SwarmProgressEntry[], sessionId: string) => void

const listeners = new Set<Listener>()
const progressByCall = new Map<string, { sessionId: string; entries: SwarmProgressEntry[] }>()
const keyOf = (callId: string, sessionId: string): string => JSON.stringify([sessionId, callId])

/** Read the latest snapshot for one call, or undefined when none arrived. */
export function getSwarmProgress(callId: string, sessionId: string): SwarmProgressEntry[] | undefined {
  const frame = progressByCall.get(keyOf(callId, sessionId))
  return frame !== undefined && frame.sessionId === sessionId ? frame.entries : undefined
}

/** Subscribe to progress updates. Returns the disposer. */
export function subscribeSwarmProgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publish one snapshot (called by the mux stream handler). */
export function publishSwarmProgress(callId: string, entries: SwarmProgressEntry[], sessionId: string): void {
  progressByCall.set(keyOf(callId, sessionId), { sessionId, entries })
  for (const listener of listeners) listener(callId, entries, sessionId)
}

export interface ClientSwarmMode { sessionId: string; active: boolean; trigger: 'manual' | 'task' | null }
const modes = new Map<string, ClientSwarmMode>()
const modeListeners = new Set<() => void>()
export const getSwarmMode = (sessionId: string): ClientSwarmMode | undefined => modes.get(sessionId)
export function subscribeSwarmMode(listener: () => void): () => void {
  modeListeners.add(listener)
  return () => { modeListeners.delete(listener) }
}
export function publishSwarmMode(frame: ClientSwarmMode): void {
  if (frame.active) modes.set(frame.sessionId, frame)
  else modes.delete(frame.sessionId)
  for (const listener of modeListeners) listener()
}
export function clearSwarmModes(): void {
  modes.clear()
  for (const listener of modeListeners) listener()
}

/** Drop one call's snapshot (memory hygiene after settlement). */
export function dropSwarmProgress(callId: string, sessionId: string): void {
  progressByCall.delete(keyOf(callId, sessionId))
}
