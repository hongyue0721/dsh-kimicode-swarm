/**
 * Progress store tests: publish/subscribe/get/drop lifecycle covers M1
 * (dropSwarmProgress called to release snapshots after settlement).
 */
import { describe, expect, it } from 'vitest'
import type { SwarmProgressEntry } from '../src/core/scheduler.ts'
import {
  dropSwarmProgress,
  getSwarmProgress,
  publishSwarmProgress,
  subscribeSwarmProgress,
} from '../src/client/progress-store.ts'

const entries: SwarmProgressEntry[] = [
  { index: 1, item: 'task-a', type: 'coder', model: null, status: 'running' },
  { index: 2, item: 'task-b', type: 'coder', model: null, status: 'queued' },
]

describe('progress store', () => {
  it('publish makes entries available via get', () => {
    publishSwarmProgress('call-1', entries, 'parent')
    expect(getSwarmProgress('call-1', 'parent')).toEqual(entries)
    // Cleanup.
    dropSwarmProgress('call-1', 'parent')
  })

  it('drop removes the snapshot so get returns undefined', () => {
    publishSwarmProgress('call-2', entries, 'parent')
    expect(getSwarmProgress('call-2', 'parent')).toBeDefined()
    dropSwarmProgress('call-2', 'parent')
    expect(getSwarmProgress('call-2', 'parent')).toBeUndefined()
  })

  it('drop is safe for unknown call ids (no throw)', () => {
    expect(() => dropSwarmProgress('nonexistent', 'parent')).not.toThrow()
  })

  it('subscribe receives updates for the matching call id', () => {
    const received: Array<{ callId: string; entries: SwarmProgressEntry[] }> = []
    const unsubscribe = subscribeSwarmProgress((callId, ents) => {
      received.push({ callId, entries: ents })
    })
    publishSwarmProgress('call-3', entries, 'parent')
    expect(received).toHaveLength(1)
    expect(received[0].callId).toBe('call-3')
    expect(received[0].entries).toEqual(entries)
    // After unsubscribe, no more updates.
    unsubscribe()
    publishSwarmProgress('call-3', entries, 'parent')
    expect(received).toHaveLength(1)
    // Cleanup.
    dropSwarmProgress('call-3', 'parent')
  })

  it('publish overwrites a previous snapshot for the same call id', () => {
    publishSwarmProgress('call-4', entries, 'parent')
    const updated: SwarmProgressEntry[] = [
      { index: 1, item: 'task-a', type: 'coder', model: null, status: 'completed' },
    ]
    publishSwarmProgress('call-4', updated, 'parent')
    expect(getSwarmProgress('call-4', 'parent')).toEqual(updated)
    // Cleanup.
    dropSwarmProgress('call-4', 'parent')
  })

  it('multiple subscribers all receive the same update', () => {
    let count1 = 0
    let count2 = 0
    const unsub1 = subscribeSwarmProgress(() => { count1 += 1 })
    const unsub2 = subscribeSwarmProgress(() => { count2 += 1 })
    publishSwarmProgress('call-5', entries, 'parent')
    expect(count1).toBe(1)
    expect(count2).toBe(1)
    unsub1()
    publishSwarmProgress('call-5', entries, 'parent')
    expect(count1).toBe(1)
    expect(count2).toBe(2)
    unsub2()
    dropSwarmProgress('call-5', 'parent')
  })
})
describe('session isolation', () => {
  it('does not return another session snapshot even when the call id matches', () => {
    publishSwarmProgress('same-call', entries, 'session-a')
    expect(getSwarmProgress('same-call', 'session-b')).toBeUndefined()
    expect(getSwarmProgress('same-call', 'session-a')).toEqual(entries)
    dropSwarmProgress('same-call', 'session-a')
  })
})

it('retains another session when an identical call id is released', () => {
  publishSwarmProgress('shared', entries, 'a')
  publishSwarmProgress('shared', [], 'b')
  dropSwarmProgress('shared', 'a')
  expect(getSwarmProgress('shared', 'a')).toBeUndefined()
  expect(getSwarmProgress('shared', 'b')).toEqual([])
  dropSwarmProgress('shared', 'b')
})
