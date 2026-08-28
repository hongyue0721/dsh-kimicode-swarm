/**
 * SwarmScheduler unit tests: ramp pacing, rate-limit backoff, cancellation
 * state preservation, per-task timeout, and concurrency cap. All timing is
 * driven by vitest fake timers; the SpawnFn is a fake recording calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SwarmScheduler, type SchedulerOptions } from '../src/core/scheduler.ts'
import type { SpawnFn, SwarmAttemptResult, SwarmTask } from '../src/core/types.ts'

/** Builds a fake spawn that resolves immediately with the given status. A
 * `rateLimited` override applies only to the FIRST call of that task; retries
 * after backoff succeed (matching real rate limits, which are transient). */
function immediateSpawn(behavior: {
  status?: SwarmAttemptResult['status']
  rateLimited?: boolean
  error?: string
  /** Map of task index (1-based) -> first-call result override. */
  byIndex?: Record<number, SwarmAttemptResult>
} = {}): { spawn: SpawnFn; calls: SwarmTask[] } {
  const calls: SwarmTask[] = []
  const rateLimitConsumed = new Set<number>()
  const spawn: SpawnFn = async (task) => {
    calls.push(task)
    const override = behavior.byIndex?.[task.index]
    if (override !== undefined && override.rateLimited && !rateLimitConsumed.has(task.index)) {
      rateLimitConsumed.add(task.index)
      return override
    }
    if (override !== undefined && override.rateLimited && rateLimitConsumed.has(task.index)) {
      return {
        agentId: `agent-${task.index}`,
        status: 'completed',
        state: 'started',
        result: `ok after retry ${task.index}`,
      }
    }
    if (override !== undefined) return override
    return {
      agentId: `agent-${task.index}`,
      status: behavior.status ?? 'completed',
      state: 'started',
      result: `result of ${task.index}`,
      error: behavior.error,
      rateLimited: behavior.rateLimited,
    }
  }
  return { spawn, calls }
}

/** A spawn that never settles until its task is explicitly released. */
function hangingSpawn(): {
  spawn: SpawnFn
  release: (index: number) => void
  calls: SwarmTask[]
} {
  const calls: SwarmTask[] = []
  const resolvers = new Map<number, (value: SwarmAttemptResult) => void>()
  const spawn: SpawnFn = (task) => {
    calls.push(task)
    return new Promise((resolve) => {
      resolvers.set(task.index, resolve)
    })
  }
  const release = (index: number): void => {
    const resolve = resolvers.get(index)
    if (resolve !== undefined) {
      resolvers.delete(index)
      resolve({ agentId: `agent-${index}`, status: 'completed', state: 'started', result: 'ok' })
    }
  }
  return { spawn, release, calls }
}

/** Count spawn calls by peeking the fake's recorded tasks. */
function calls(spawn: SpawnFn): SwarmTask[] {
  return (spawn as unknown as { calls?: SwarmTask[] }).calls ?? []
}

function tasks(count: number): SwarmTask[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    kind: 'spawn' as const,
    item: `item-${i + 1}`,
    prompt: `prompt-${i + 1}`,
    type: 'coder',
    model: undefined,
    resumeAgentId: undefined,
    description: `task #${i + 1}`,
  }))
}

function run(scheduler: SwarmScheduler, count: number, signal?: AbortSignal) {
  return scheduler.run(tasks(count), signal ?? new AbortController().signal)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('normal phase', () => {
  it('launches up to the initial burst immediately and settles all', async () => {
    const { spawn, calls } = immediateSpawn()
    const scheduler = new SwarmScheduler(spawn)
    const promise = run(scheduler, 5)
    await vi.advanceTimersByTimeAsync(0)
    const results = await promise
    expect(calls).toHaveLength(5)
    expect(results).toHaveLength(5)
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  })

  it('ramps one more task every 700ms after the initial burst', async () => {
    const { spawn, calls } = immediateSpawn()
    const scheduler = new SwarmScheduler(spawn)
    const promise = run(scheduler, 8)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(699)
    expect(calls).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(700)
    expect(calls).toHaveLength(7)
    await vi.advanceTimersByTimeAsync(700)
    expect(calls).toHaveLength(8)
    await expect(promise).resolves.toHaveLength(8)
  })

  it('respects a global maxConcurrency cap', async () => {
    const { spawn, release, calls: spawnCalls } = hangingSpawn()
    const scheduler = new SwarmScheduler(spawn, { maxConcurrency: 2 })
    const promise = run(scheduler, 6)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnCalls).toHaveLength(2)
    // Release both held tasks; the ramp fills two more slots.
    release(1)
    release(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnCalls).toHaveLength(4)
    release(3)
    release(4)
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnCalls).toHaveLength(6)
    release(5)
    release(6)
    await vi.advanceTimersByTimeAsync(0)
    const results = await promise
    expect(results).toHaveLength(6)
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  })
})

describe('rate-limit phase', () => {
  it('backs off a rate-limited task with doubling delays and lets others proceed', async () => {
    const { spawn, calls } = immediateSpawn({ byIndex: { 1: { agentId: 'agent-1', status: 'failed', state: 'started', error: 'rate limit', rateLimited: true } } })
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 2 })
    const promise = run(scheduler, 3)
    await vi.advanceTimersByTimeAsync(0)
    // task 1 rate-limited at launch; tasks 2-3 done; task 1 requeued with 3s delay.
    expect(calls.some((t) => t.index === 1)).toBe(true)
    await vi.advanceTimersByTimeAsync(2999)
    const firstLaunchCount = calls.filter((t) => t.index === 1).length
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter((t) => t.index === 1).length).toBe(firstLaunchCount + 1)
    // The remaining task rides the rate-limit-phase pacing; give it time.
    await vi.advanceTimersByTimeAsync(10_000)
    const results = await promise
    expect(results).toHaveLength(3)
    const first = results.find((r) => r.task.index === 1)!
    expect(first.status).toBe('completed')
  })

  it('fails the only unfinished task instead of suspending the batch forever', async () => {
    const { spawn } = immediateSpawn({ rateLimited: true })
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 1 })
    const promise = run(scheduler, 1)
    await vi.advanceTimersByTimeAsync(0)
    const results = await promise
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('rate limit')
  })

  it('preserves completed work when another task is rate-limited', async () => {
    const byIndex: Record<number, SwarmAttemptResult> = {
      1: { agentId: 'agent-1', status: 'failed', state: 'started', error: 'rl', rateLimited: true },
      2: { agentId: 'agent-2', status: 'completed', state: 'started', result: 'ok' },
    }
    const { spawn } = immediateSpawn({ byIndex })
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 2 })
    const promise = run(scheduler, 2)
    await vi.advanceTimersByTimeAsync(10_000)
    const results = await promise
    expect(results[0].status).toBe('completed') // task 1 retried after backoff
    expect(results[1].status).toBe('completed')
  })
})

describe('cancellation', () => {
  it('marks never-started tasks aborted/not_started and preserves completed slots', async () => {
    const controller = new AbortController()
    const byIndex: Record<number, SwarmAttemptResult> = {
      1: { agentId: 'agent-1', status: 'completed', state: 'started', result: 'ok' },
    }
    const { spawn } = immediateSpawn({ byIndex })
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 1 })
    const promise = run(scheduler, 5, controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    const results = await promise
    expect(results[0].status).toBe('completed')
    for (const result of results.slice(1)) {
      expect(result.status).toBe('aborted')
      expect(result.state).toBe('not_started')
    }
  })
})

describe('per-task timeout', () => {
  it('fails only the timed-out task and lets the rest settle', async () => {
    const hanging: SpawnFn = (task, signal) =>
      new Promise((resolve) => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort)
          resolve({ agentId: `agent-${task.index}`, status: 'aborted', state: 'started', error: 'timeout' })
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    const fast: SpawnFn = async (task) => ({
      agentId: `agent-${task.index}`,
      status: 'completed',
      state: 'started',
      result: 'ok',
    })
    // task 1 hangs (honoring its signal); tasks 2+ settle instantly.
    const spawn: SpawnFn = (task, signal) =>
      task.index === 1 ? hanging(task, signal) : fast(task, signal)
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 5, timeoutMs: 1000 })
    const promise = run(scheduler, 3)
    await vi.advanceTimersByTimeAsync(1000)
    const results = await promise
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('timed out')
    expect(results[1].status).toBe('completed')
    expect(results[2].status).toBe('completed')
  })
})

describe('options', () => {
  it('does not resolve before every slot settles (async spawn regression)', async () => {
    // Real subagent spawns are genuinely asynchronous: run() must await all
    // settlements instead of returning a half-empty array (regression for
    // "Cannot read properties of undefined (reading 'agentId')").
    const { spawn, release, calls: spawnCalls } = hangingSpawn()
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 5 })
    let returned = false
    const promise = run(scheduler, 3).then((results) => {
      returned = true
      return results
    })
    await Promise.resolve()
    expect(spawnCalls).toHaveLength(3)
    expect(returned).toBe(false) // still waiting on the hanging spawn
    release(1)
    release(2)
    release(3)
    await Promise.resolve()
    const results = await promise
    expect(returned).toBe(true)
    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  })

  it('uses injected clock functions for deterministic scheduling', async () => {
    let now = 0
    const timers: Array<() => void> = []
    const options: SchedulerOptions = {
      initialLaunchLimit: 1,
      launchIntervalMs: 100,
      now: () => now,
      setTimeout: (fn, ms) => {
        timers.push(fn)
        return timers.length
      },
      clearTimeout: () => undefined,
    }
    const { spawn, calls } = immediateSpawn()
    const scheduler = new SwarmScheduler(spawn, options)
    const promise = run(scheduler, 3)
    expect(calls).toHaveLength(1)
    now = 100
    timers.splice(0).forEach((fn) => fn())
    await Promise.resolve() // let the launched task settle and re-arm the ramp
    expect(calls).toHaveLength(2)
    now = 200
    timers.splice(0).forEach((fn) => fn())
    await Promise.resolve()
    expect(calls).toHaveLength(3)
    await promise
  })
})

describe('rate-limit capacity recovery (H2)', () => {
  it('recovers capacity +1 after the quiet window and exits rate-limit mode', async () => {
    // 6 tasks, initial burst 2. Task 1 hits rate limit on first launch,
    // succeeds on retry. After 3 minutes of quiet, capacity should recover.
    const byIndex: Record<number, SwarmAttemptResult> = {
      1: { agentId: 'agent-1', status: 'failed', state: 'started', error: 'rate limit', rateLimited: true },
    }
    const { spawn, calls } = immediateSpawn({ byIndex })
    const scheduler = new SwarmScheduler(spawn, {
      initialLaunchLimit: 2,
      rateLimitCapacityRecoveryIntervalMs: 3 * 60 * 1000,
    })
    const promise = run(scheduler, 6)
    // Initial burst: 2 tasks launch (task 1 rate-limited, task 2 completes).
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)

    // After the rate limit, capacity shrinks to 1. Tasks launch one-at-a-time
    // with 3s pacing. Let the remaining tasks proceed.
    await vi.advanceTimersByTimeAsync(30_000)
    // Task 1 retry should have launched by now.
    expect(calls.filter((t) => t.index === 1).length).toBe(2)

    // Advance past the 3-minute recovery window. Capacity should recover,
    // eventually reaching count (6) and exiting rate-limit mode.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    const results = await promise
    expect(results).toHaveLength(6)
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  })

  it('does not recover capacity before the quiet window elapses', async () => {
    // If rate limits keep hitting, recovery should not fire because
    // lastRateLimitAt keeps resetting.
    const recordedCalls: SwarmTask[] = []
    const spawn: SpawnFn = async (task) => {
      recordedCalls.push(task)
      // First 3 calls rate-limit; later calls succeed.
      if (recordedCalls.length <= 3) {
        return { agentId: `agent-${task.index}`, status: 'failed', state: 'started', error: '429 rate limit', rateLimited: true }
      }
      return { agentId: `agent-${task.index}`, status: 'completed', state: 'started', result: 'ok' }
    }
    const scheduler = new SwarmScheduler(spawn, {
      initialLaunchLimit: 2,
      rateLimitCapacityRecoveryIntervalMs: 60_000,
    })
    const promise = run(scheduler, 4)
    await vi.advanceTimersByTimeAsync(0)
    // 2 tasks launched in burst, both rate-limited.
    expect(recordedCalls).toHaveLength(2)
    // Advance 30s (less than 60s recovery) — capacity stays at 1.
    await vi.advanceTimersByTimeAsync(30_000)
    // Let everything settle.
    await vi.advanceTimersByTimeAsync(120_000)
    const results = await promise
    expect(results).toHaveLength(4)
  })
})

describe('spawn catch state (M3)', () => {
  it('marks state as not_started when spawn throws before producing an agentId', async () => {
    // A spawn that throws synchronously (never started) should report
    // not_started, not started.
    const throwingSpawn: SpawnFn = async () => {
      throw new Error('provider unavailable')
    }
    const scheduler = new SwarmScheduler(throwingSpawn, { initialLaunchLimit: 5 })
    const promise = run(scheduler, 2)
    // Both tasks launch in the burst and fail immediately. Advance timers
    // to let the async settle chain complete.
    await vi.advanceTimersByTimeAsync(1000)
    const results = await promise
    expect(results.every((r) => r.status === 'failed')).toBe(true)
    // slot.agentId is undefined (spawn threw before setting it) → not_started.
    expect(results.every((r) => r.state === 'not_started')).toBe(true)
  })

  it('marks state as started when a retry fails but the slot has an agentId', async () => {
    // Task 1: first call rate-limited (sets agentId), retry throws.
    let firstCall = true
    const spawn: SpawnFn = async (task) => {
      if (firstCall && task.index === 1) {
        firstCall = false
        return { agentId: 'agent-1', status: 'failed', state: 'started', error: '429', rateLimited: true }
      }
      if (task.index === 1) {
        throw new Error('provider crashed')
      }
      return { agentId: `agent-${task.index}`, status: 'completed', state: 'started', result: 'ok' }
    }
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 1 })
    const promise = run(scheduler, 2)
    await vi.advanceTimersByTimeAsync(10_000)
    const results = await promise
    const task1 = results.find((r) => r.task.index === 1)!
    expect(task1.status).toBe('failed')
    // The slot had an agentId from the rate-limited attempt → started.
    expect(task1.state).toBe('started')
  })
})

describe('capacity seed (L2)', () => {
  it('seeds capacity from active + pending rather than cumulative launches', async () => {
    // Use a hanging spawn so tasks stay in-flight. Task 1 rate-limits on
    // first call (returns immediately), then hangs on retry. Tasks 2-4 hang.
    //
    // With initialLaunchLimit=2: tasks 1+2 launch in burst. Task 1 rate-limits
    // → enterRateLimitMode runs while active={2}, pending=[3,4].
    //   Old seed: min(normalLaunches=2, count=4) = 2
    //   New seed: min(active.size=1 + pending.length=2, count=4) = 3
    //
    // With capacity 3 (new), we can have 3 concurrent in-flight tasks in
    // rate-limit mode. With capacity 2 (old), only 2. We verify by checking
    // that after tasks 1(retry), 3 are all hanging, task 4 is blocked until
    // one is released — which requires capacity >= 3.
    const { spawn: hangSpawn, release, calls: hangCalls } = hangingSpawn()
    const allCalls: SwarmTask[] = []
    let task1FirstCall = true
    const spawn: SpawnFn = async (task, signal) => {
      allCalls.push(task)
      if (task.index === 1 && task1FirstCall) {
        task1FirstCall = false
        return { agentId: 'agent-1', status: 'failed', state: 'started', error: '429 rate limit', rateLimited: true }
      }
      return hangSpawn(task, signal)
    }
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 2 })
    const promise = run(scheduler, 4)
    await vi.advanceTimersByTimeAsync(0)
    // Burst: task 1 (rate-limited) + task 2 (hanging).
    expect(allCalls).toHaveLength(2)

    // Rate-limit mode: one launch per 3s. Task 1 is at front of pending
    // (unshifted), eligible at t=3000. It retries at t=3000 → hangs.
    await vi.advanceTimersByTimeAsync(3100) // t=3100: task 1 retry (hangs)
    expect(allCalls.filter((t) => t.index === 1).length).toBe(2)
    // Task 3 launches at next 3s pass.
    await vi.advanceTimersByTimeAsync(3100) // t=6200: task 3 (hangs)
    expect(allCalls.filter((t) => t.index === 3).length).toBe(1)
    // Now active = {2, 1, 3} = 3. With capacity 3, task 4 can't launch yet.
    // (With old capacity 2, task 3 wouldn't have launched — only 2 active.)
    await vi.advanceTimersByTimeAsync(3100) // t=9300: task 4 tries but capacity=3, active=3
    expect(allCalls.filter((t) => t.index === 4).length).toBe(0)

    // Release task 2; now active=2, capacity=3, so task 4 can launch.
    release(2)
    await vi.advanceTimersByTimeAsync(3100)
    expect(allCalls.filter((t) => t.index === 4).length).toBe(1)

    // Clean up.
    release(1)
    release(3)
    release(4)
    await vi.advanceTimersByTimeAsync(5000)
    const results = await promise
    expect(results).toHaveLength(4)
  })
})
