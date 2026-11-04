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
  const spawn: SpawnFn = async (task, _signal, attempt) => {
    calls.push(task)
    attempt.onStarted(`agent-${task.index}`)
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
  const spawn: SpawnFn = (task, _signal, attempt) => {
    calls.push(task)
    attempt.onStarted(`agent-${task.index}`)
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

let testAbort = new AbortController()

/** Signal aborted by cancelPending, for runs whose hanging tasks never settle. */
function abortAfterTest(): AbortSignal {
  testAbort = new AbortController()
  return testAbort.signal
}

async function cancelPending(promise: Promise<unknown>): Promise<void> {
  testAbort.abort()
  await promise
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
    const spawn: SpawnFn = (task, signal, attempt) =>
      task.index === 1 ? hanging(task, signal, attempt) : fast(task, signal, attempt)
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
  it('completes queued work after entering persistent rate-limit mode', async () => {
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
    // without returning to the normal launch mode.
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
    const spawn: SpawnFn = async (task, _signal, attempt) => {
      attempt.onStarted(`agent-${task.index}`)
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
  it('seeds capacity from successful publications minus one, excluding pending work', async () => {
    const { spawn: hang, release } = hangingSpawn()
    const indexes: number[] = []
    let first = true
    const spawn: SpawnFn = async (task, signal, attempt) => {
      indexes.push(task.index)
      attempt.onStarted(`agent-${task.index}`)
      if (task.index === 1 && first) {
        first = false
        return { agentId: 'agent-1', status: 'failed', state: 'started', rateLimited: true }
      }
      return hang(task, signal, attempt)
    }
    const promise = run(new SwarmScheduler(spawn, { initialLaunchLimit: 3 }), 6)
    await vi.advanceTimersByTimeAsync(0)
    expect(indexes).toEqual([1, 2, 3])
    // Three published children seed capacity two; queued work cannot inflate it.
    await vi.advanceTimersByTimeAsync(3000)
    expect(indexes).toEqual([1, 2, 3])
    release(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(indexes).toEqual([1, 2, 3, 1])
    await vi.advanceTimersByTimeAsync(3000)
    expect(indexes).toEqual([1, 2, 3, 1])
    release(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(indexes).toEqual([1, 2, 3, 1, 4])
    release(1); release(4)
    await vi.advanceTimersByTimeAsync(3000)
    release(5)
    await vi.advanceTimersByTimeAsync(3000)
    release(6)
    const results = await promise
    expect(results).toHaveLength(6)
    expect(results.every((result) => result.status === 'completed')).toBe(true)
  })
})

describe('sustained ramp (O1, O3)', () => {
  it('keeps launching on the interval while earlier tasks are still running', async () => {
    const { spawn, calls: spawnCalls } = hangingSpawn()
    const promise = run(new SwarmScheduler(spawn), 20, abortAfterTest())
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnCalls).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(700 * 3)
    expect(spawnCalls).toHaveLength(8)
    await vi.advanceTimersByTimeAsync(700 * 12)
    expect(spawnCalls).toHaveLength(20)
    await cancelPending(promise)
  })

  it('arms one timer per pending launch instead of spinning on zero-delay wakes', async () => {
    const { spawn } = hangingSpawn()
    const delays: number[] = []
    const scheduler = new SwarmScheduler(spawn, {
      setTimeout: (fn, ms) => {
        delays.push(ms)
        return setTimeout(fn, ms)
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
    const promise = run(scheduler, 10, abortAfterTest())
    await vi.advanceTimersByTimeAsync(700 * 5)
    expect(delays).toEqual([700, 700, 700, 700, 700])
    await cancelPending(promise)
  })
})

describe('host capacity (O2)', () => {
  /** Spawn that refuses like the host once `limit` of its children are running. */
  function limitedSpawn(limit: number) {
    const running = new Set<number>()
    const release = new Map<number, () => void>()
    let refusals = 0
    let peak = 0
    const spawn: SpawnFn = (task) => {
      if (running.size >= limit) {
        refusals += 1
        return Promise.resolve({
          agentId: undefined,
          status: 'failed',
          state: 'not_started',
          error: 'subagent limit reached',
          capacityLimited: true,
        })
      }
      running.add(task.index)
      peak = Math.max(peak, running.size)
      return new Promise((resolve) => {
        release.set(task.index, () => {
          running.delete(task.index)
          resolve({ agentId: `agent-${task.index}`, status: 'completed', state: 'started', result: 'ok' })
        })
      })
    }
    return { spawn, release, stats: () => ({ refusals, peak }) }
  }

  it('requeues refused tasks and finishes all of them without a failure', async () => {
    const { spawn, release, stats } = limitedSpawn(3)
    const promise = run(new SwarmScheduler(spawn), 8)
    for (let tick = 0; tick < 40; tick += 1) {
      await vi.advanceTimersByTimeAsync(700)
      const first = release.keys().next().value
      if (first !== undefined) {
        release.get(first)?.()
        release.delete(first)
      }
    }
    const results = await promise
    expect(results.every((r) => r.status === 'completed')).toBe(true)
    expect(stats().peak).toBe(3)
  })

  it('stops launching while refused, retrying once per settled attempt', async () => {
    const { spawn, release, stats } = limitedSpawn(2)
    const promise = run(new SwarmScheduler(spawn), 6, abortAfterTest())
    await vi.advanceTimersByTimeAsync(0)
    const refusalsAfterBurst = stats().refusals
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stats().refusals).toBe(refusalsAfterBurst)
    release.get(1)?.()
    release.delete(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(stats().refusals).toBeLessThanOrEqual(refusalsAfterBurst + 1)
    await cancelPending(promise)
  })

  it('retries on a timer when another owner holds every slot', async () => {
    let free = false
    const attempts: number[] = []
    const spawn: SpawnFn = async (task) => {
      attempts.push(task.index)
      if (!free) {
        return { agentId: undefined, status: 'failed', state: 'not_started', error: 'limit', capacityLimited: true }
      }
      return { agentId: `agent-${task.index}`, status: 'completed', state: 'started', result: 'ok' }
    }
    const promise = run(new SwarmScheduler(spawn, { initialLaunchLimit: 1 }), 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(attempts.length).toBeGreaterThan(1)
    free = true
    await vi.advanceTimersByTimeAsync(10_000)
    const results = await promise
    expect(results.every((r) => r.status === 'completed')).toBe(true)
  })
})

describe('persistent rate limits (O5)', () => {
  it('fails tasks that stay limited instead of keeping each other alive forever', async () => {
    const spawn: SpawnFn = async () => ({
      agentId: undefined,
      status: 'failed',
      state: 'not_started',
      error: 'quota exhausted',
      rateLimited: true,
    })
    const promise = run(new SwarmScheduler(spawn, { maxRateLimitRetries: 2 }), 2)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    const results = await promise
    expect(results.every((r) => r.status === 'failed')).toBe(true)
    expect(results.every((r) => r.state === 'not_started')).toBe(true)
    expect(results.every((r) => r.error === 'quota exhausted')).toBe(true)
  })

  it('bounds the retries by default', async () => {
    let attempts = 0
    const spawn: SpawnFn = async () => {
      attempts += 1
      return { agentId: 'a', status: 'failed', state: 'started', error: 'limit', rateLimited: true }
    }
    const promise = run(new SwarmScheduler(spawn), 2)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    const results = await promise
    expect(results.every((r) => r.status === 'failed')).toBe(true)
    expect(attempts).toBeLessThanOrEqual(2 * 9)
  })
})

describe('attempt context', () => {
  it('reports published child ids on cancellation so the work can be resumed (O6)', async () => {
    const controller = new AbortController()
    const spawn: SpawnFn = (task, _signal, attempt) => {
      attempt.onStarted(`child-${task.index}`)
      return new Promise(() => {})
    }
    const promise = run(new SwarmScheduler(spawn, { initialLaunchLimit: 1 }), 2, controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    const results = await promise
    expect(results[0]).toMatchObject({ agentId: 'child-1', status: 'aborted', state: 'started' })
    expect(results[1]).toMatchObject({ agentId: undefined, status: 'aborted', state: 'not_started' })
  })

  it('offers a rate-limited child back for retry', async () => {
    const retries: Array<string | undefined> = []
    const spawn: SpawnFn = async (task, _signal, attempt) => {
      if (task.index !== 1) return { agentId: 'b', status: 'completed', state: 'started', result: 'ok' }
      retries.push(attempt.retryAgentId)
      if (retries.length === 1) {
        return { agentId: 'child-1', status: 'failed', state: 'started', error: 'limit', rateLimited: true }
      }
      return { agentId: 'child-1', status: 'completed', state: 'started', result: 'ok' }
    }
    const promise = run(new SwarmScheduler(spawn), 2)
    await vi.advanceTimersByTimeAsync(10_000)
    await promise
    expect(retries).toEqual([undefined, 'child-1'])
  })
})

describe('v2 global backoff and progress', () => {
  it('doubles unpublished rate-limit delays and resets pacing when a child publishes', async () => {
    const started = Date.now()
    const launches: Array<[number, number]> = []
    const snapshots: import('../src/core/scheduler.ts').SwarmProgressEntry[][] = []
    let limited = 0
    const spawn: SpawnFn = async (task, _signal, attempt) => {
      launches.push([task.index, Date.now() - started])
      if (task.index === 1 && limited++ < 2) return { agentId: undefined, status: 'failed', state: 'not_started', rateLimited: true }
      attempt.onStarted(`child-${task.index}`)
      return { agentId: `child-${task.index}`, status: 'completed', state: 'started' }
    }
    const scheduler = new SwarmScheduler(spawn, { initialLaunchLimit: 1, onProgress: (entries) => snapshots.push(entries) })
    const promise = run(scheduler, 3)
    await vi.advanceTimersByTimeAsync(0)
    const waiting = snapshots.find((entries) => entries[0].status === 'rate_limited')![0]
    expect(waiting.retries).toBe(1)
    expect(waiting.retryAt).toBe(started + 6000)
    expect(waiting.agentId).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5999)
    expect(launches).toEqual([[1, 0]])
    await vi.advanceTimersByTimeAsync(1)
    expect(launches).toEqual([[1, 0], [1, 6000]])
    await vi.advanceTimersByTimeAsync(11999)
    expect(launches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(launches).toEqual([[1, 0], [1, 6000], [1, 18000]])
    await vi.advanceTimersByTimeAsync(2999)
    expect(launches).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(launches[3]).toEqual([2, 21000])
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise
    expect(result.map((entry) => entry.status)).toEqual(['completed', 'completed', 'completed'])
    expect(result[0]).toMatchObject({ startedAt: started + 18000, settledAt: started + 18000, retries: 2, toolCalls: 0 })
  })

  it('reports host-clock timestamps and only counts tools for running published children', async () => {
    const hanging = hangingSpawn()
    const snapshots: import('../src/core/scheduler.ts').SwarmProgressEntry[][] = []
    const scheduler = new SwarmScheduler(hanging.spawn, { onProgress: (entries) => snapshots.push(entries) })
    const promise = run(scheduler, 2)
    scheduler.toolResult('other', 'Ignored')
    scheduler.toolResult('agent-1', 'Read')
    scheduler.toolResult('agent-1', 'Bash')
    const row = snapshots.at(-1)![0]
    expect(row).toMatchObject({ agentId: 'agent-1', toolCalls: 2, activity: 'Bash', status: 'running' })
    expect(row.startedAt).toBe(Date.now())
    hanging.release(1)
    await vi.advanceTimersByTimeAsync(0)
    scheduler.toolResult('agent-1', 'After settlement')
    hanging.release(2)
    await vi.advanceTimersByTimeAsync(0)
    const results = await promise
    expect(results[0].toolCalls).toBe(2)
    expect(results[0].activity).toBe('Bash')
    expect(results[0].settledAt).toBe(Date.now())
  })
})

describe('capacity recovery with published running children', () => {
  it('recovers one capacity slot per quiet window while keeping existing children', async () => {
    const hanging = hangingSpawn()
    const indexes: number[] = []
    let first = true
    const spawn: SpawnFn = async (task, signal, attempt) => {
      indexes.push(task.index)
      attempt.onStarted(`agent-${task.index}`)
      if (task.index === 1 && first) {
        first = false
        return { agentId: 'agent-1', status: 'failed', state: 'started', rateLimited: true }
      }
      return hanging.spawn(task, signal, attempt)
    }
    const controller = new AbortController()
    const promise = run(new SwarmScheduler(spawn, { initialLaunchLimit: 2 }), 4, controller.signal)
    await vi.advanceTimersByTimeAsync(179999)
    expect(indexes).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(1)
    expect(indexes).toEqual([1, 2, 1])
    await vi.advanceTimersByTimeAsync(179999)
    expect(indexes).toEqual([1, 2, 1])
    await vi.advanceTimersByTimeAsync(1)
    expect(indexes).toEqual([1, 2, 1, 3])
    controller.abort()
    expect((await promise).map((result) => result.state)).toEqual(['started', 'started', 'started', 'not_started'])
  })
})

describe('publication is the start fact', () => {
  it('does not invent a started child when cancelled during pre-publication', async () => {
    const controller = new AbortController()
    const scheduler = new SwarmScheduler(async () => new Promise(() => {}))
    const promise = run(scheduler, 2, controller.signal)
    controller.abort()
    const results = await promise
    expect(results.map((result) => result.state)).toEqual(['not_started', 'not_started'])
    expect(results.every((result) => result.agentId === undefined && result.startedAt === undefined)).toBe(true)
  })
  it('reports a pre-publication timeout without a fabricated child id or start time', async () => {
    const spawn: SpawnFn = (_task, signal) => new Promise((resolve) => signal.addEventListener('abort', () => {
      resolve({ agentId: undefined, status: 'aborted', state: 'not_started' })
    }, { once: true }))
    const promise = run(new SwarmScheduler(spawn, { timeoutMs: 100 }), 2)
    await vi.advanceTimersByTimeAsync(100)
    const results = await promise
    expect(results.map((result) => result.state)).toEqual(['not_started', 'not_started'])
    expect(results.every((result) => result.status === 'failed' && result.agentId === undefined && result.startedAt === undefined)).toBe(true)
  })
})
