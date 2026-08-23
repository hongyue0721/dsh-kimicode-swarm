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
type Listener = (callId: string, entries: SwarmProgressEntry[]) => void

const listeners = new Set<Listener>()
const progressByCall = new Map<string, SwarmProgressEntry[]>()

/** Read the latest snapshot for one call, or undefined when none arrived. */
export function getSwarmProgress(callId: string): SwarmProgressEntry[] | undefined {
  return progressByCall.get(callId)
}

/** Subscribe to progress updates. Returns the disposer. */
export function subscribeSwarmProgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publish one snapshot (called by the mux stream handler). */
export function publishSwarmProgress(callId: string, entries: SwarmProgressEntry[]): void {
  progressByCall.set(callId, entries)
  for (const listener of listeners) listener(callId, entries)
}

/** Drop one call's snapshot (memory hygiene after settlement). */
export function dropSwarmProgress(callId: string): void {
  progressByCall.delete(callId)
}
