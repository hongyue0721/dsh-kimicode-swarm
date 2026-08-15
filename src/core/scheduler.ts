/**
 * SwarmScheduler: two-phase adaptive concurrency for a batch of subagent
 * tasks. The algorithm mirrors the published Kimi Code SubagentBatch contract
 * (same tuning constants, re-implemented against a structural SpawnFn):
 *
 * Normal phase:
 * - Start up to 5 tasks immediately, then 1 more every 700ms while queued
 *   work remains. An optional maxConcurrency caps the ramp.
 * Rate-limit phase:
 * - A rate-limited attempt requeues at the front with exponential personal
 *   delays (3s, 6s, 12s, doubling). Capacity starts at the ready launches
 *   (min 1), shrinks by 1 per later limit (min 1, at most once per 2s), and
 *   recovers +1 after 3 minutes without a limit (may launch one immediately).
 * - At most 1 task launches per pass; a rate-limited attempt that is the only
 *   unfinished task fails instead of suspending the batch.
 * Cancellation:
 * - Completed results are preserved; started-but-unfinished tasks are marked
 *   aborted/started; never-started tasks aborted/not_started.
 * Timeout:
 * - A per-task timeout fails only that task; it does not stop the others.
 */
import type { SpawnFn, SwarmAttemptResult, SwarmRunResult, SwarmTask } from './types.ts'

/** One subagent's live progress entry, in input order. */
export interface SwarmProgressEntry {
  index: number
  item: string | null
  type: string | null
  model: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
}

/** Scheduler tuning; defaults mirror Kimi's published constants. */
export interface SchedulerOptions {
  /** Tasks launched immediately when the batch starts. */
  initialLaunchLimit?: number
  /** Interval between normal-phase launches after the initial burst. */
  launchIntervalMs?: number
  /** Base personal retry delay after a rate limit (doubles per retry). */
  rateLimitRetryBaseMs?: number
  /** Personal delay growth factor per rate-limited retry. */
  rateLimitRetryFactor?: number
  /** Minimum gap between capacity shrinks. */
  rateLimitCapacityShrinkIntervalMs?: number
  /** Quiet window after which capacity recovers by 1. */
  rateLimitCapacityRecoveryIntervalMs?: number
  /** Optional global concurrency cap (0 = unlimited, ramp still applies). */
  maxConcurrency?: number
  /** Per-task timeout in ms; 0 = no timeout. */
  timeoutMs?: number
  /** Clock for tests; defaults to the real Date.now / setTimeout. */
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /**
   * Progress callback: fired with a full ordered snapshot whenever any slot's
   * status changes (launch, settle, rate-limit requeue, cancellation). The
   * host half maps these onto a session event the UI renders as live rows.
   */
  onProgress?: (entries: SwarmProgressEntry[]) => void
}

export interface ResolvedSchedulerOptions {
  initialLaunchLimit: number
  launchIntervalMs: number
  rateLimitRetryBaseMs: number
  rateLimitRetryFactor: number
  rateLimitCapacityShrinkIntervalMs: number
  rateLimitCapacityRecoveryIntervalMs: number
  maxConcurrency: number
  timeoutMs: number
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  onProgress: ((entries: SwarmProgressEntry[]) => void) | undefined
}

export function resolveOptions(options: SchedulerOptions = {}): ResolvedSchedulerOptions {
  return {
    initialLaunchLimit: options.initialLaunchLimit ?? 5,
    launchIntervalMs: options.launchIntervalMs ?? 700,
    rateLimitRetryBaseMs: options.rateLimitRetryBaseMs ?? 3000,
    rateLimitRetryFactor: options.rateLimitRetryFactor ?? 2,
    rateLimitCapacityShrinkIntervalMs: options.rateLimitCapacityShrinkIntervalMs ?? 2000,
    rateLimitCapacityRecoveryIntervalMs: options.rateLimitCapacityRecoveryIntervalMs ?? 3 * 60 * 1000,
    maxConcurrency: options.maxConcurrency ?? 0,
    timeoutMs: options.timeoutMs ?? 0,
    now: options.now ?? Date.now,
    setTimeout: options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    onProgress: options.onProgress,
  }
}

/** Per-slot scheduler state. */
interface SlotState {
  task: SwarmTask
  /** Personal earliest-launch timestamp (rate-limit backoff). */
  eligibleAt: number
  /** Personal delay currently applied (doubles per rate-limited retry). */
  delay: number
  /** Last published agent id, kept for same-agent retry. */
  agentId: string | undefined
  /** Number of rate-limit hits this slot has taken. */
  rateLimitHits: number
  /** Current live status for the progress feed. */
  status: SwarmProgressEntry['status']
}

export class SwarmScheduler {
  private readonly options: ResolvedSchedulerOptions

  constructor(
    private readonly spawn: SpawnFn,
    options: SchedulerOptions = {},
  ) {
    this.options = resolveOptions(options)
  }

  async run(tasks: SwarmTask[], signal: AbortSignal): Promise<SwarmRunResult[]> {
    const opts = this.options
    const count = tasks.length
    const results: Array<SwarmRunResult | undefined> = new Array(count)
    const slots: SlotState[] = tasks.map((task, index) => ({
      task,
      eligibleAt: 0,
      delay: 0,
      agentId: undefined,
      rateLimitHits: 0,
      status: 'queued',
    }))
    /** Pending slot indexes in launch order. */
    const pending: number[] = tasks.map((_, index) => index)
    const active = new Set<number>()
    let settled = 0
    let normalLaunches = 0
    let rateLimitMode = false
    let capacity = 1
    let nextLaunchAt = 0
    let lastRateLimitAt = 0
    let lastCapacityShrinkAt = 0
    let wakeTimer: unknown | undefined
    let finished = false
    /** Resolves when every slot has settled; run() awaits it before returning. */
    let resolveAll: () => void
    const allSettled = new Promise<void>((resolve) => {
      resolveAll = resolve
    })

    /** Push the current per-slot status snapshot to the progress feed. */
    const emitProgress = (): void => {
      opts.onProgress?.(
        slots.map((slot) => ({
          index: slot.task.index,
          item: slot.task.item ?? null,
          type: slot.task.type ?? null,
          model: slot.task.model?.model ?? null,
          status: slot.status,
        })),
      )
    }

    const setStatus = (index: number, status: SwarmProgressEntry['status']): void => {
      slots[index].status = status
      emitProgress()
    }

    const settle = (index: number, result: SwarmRunResult): void => {
      results[index] = result
      setStatus(index, result.status)
      settled += 1
      if (settled === count) finish()
    }

    const finish = (): void => {
      if (finished) return
      finished = true
      if (wakeTimer !== undefined) {
        opts.clearTimeout(wakeTimer)
        wakeTimer = undefined
      }
      resolveAll()
    }

    const cancelAll = (): void => {
      // Preserve completed slots; mark the rest by their start state.
      for (let index = 0; index < count; index += 1) {
        if (results[index] !== undefined) continue
        const slot = slots[index]
        const started = active.has(index) || slot.agentId !== undefined
        settle(index, {
          task: slot.task,
          agentId: slot.agentId,
          status: 'aborted',
          state: started ? 'started' : 'not_started',
          error: 'The user manually interrupted this swarm before this subagent finished.',
        })
      }
    }

    const launch = async (index: number): Promise<void> => {
      // NOTE: the slot left `pending` and entered `active` in launchNow();
      // do not re-splice here (indexOf would hit -1 and drop the queue tail).
      const slot = slots[index]
      const attempt = await this.runAttempt(slot, signal)
      active.delete(index)
      if (finished) return

      if (signal.aborted) {
        settle(index, {
          task: slot.task,
          agentId: attempt.agentId ?? slot.agentId,
          status: 'aborted',
          state: attempt.agentId !== undefined || attempt.state === 'started' ? 'started' : 'not_started',
          error: attempt.error ?? 'The user manually interrupted this swarm before this subagent finished.',
        })
        return
      }

      if (attempt.rateLimited) {
        slot.agentId = attempt.agentId ?? slot.agentId
        slot.rateLimitHits += 1
        const otherUnfinished = pending.length > 0 || active.size > 0
        if (!otherUnfinished) {
          // The only unfinished task: fail it instead of suspending the batch.
          settle(index, {
            task: slot.task,
            agentId: slot.agentId,
            status: 'failed',
            state: 'started',
            error: attempt.error ?? 'Provider rate limit; no other work to wait for.',
          })
          return
        }
        enterRateLimitMode()
        slot.delay =
          slot.delay === 0
            ? opts.rateLimitRetryBaseMs
            : Math.min(slot.delay * opts.rateLimitRetryFactor, 5 * 60 * 1000)
        slot.eligibleAt = opts.now() + slot.delay
        pending.unshift(index)
        setStatus(index, 'queued') // rate-limit requeue: back to the queue
      } else {
        settle(index, {
          task: slot.task,
          agentId: attempt.agentId ?? slot.agentId,
          status: attempt.status,
          state: attempt.state,
          result: attempt.result,
          error: attempt.error,
        })
      }
      schedule()
    }

    const enterRateLimitMode = (): void => {
      const now = opts.now()
      if (!rateLimitMode) {
        rateLimitMode = true
        // Enter with capacity equal to ready launches, minimum 1; next global
        // launch no earlier than the base retry delay.
        capacity = Math.max(1, Math.min(normalLaunches, count))
        nextLaunchAt = now + opts.rateLimitRetryBaseMs
        lastRateLimitAt = now
        lastCapacityShrinkAt = now
        return
      }
      // Later rate limits shrink capacity by 1 (min 1), at most once per 2s.
      if (now - lastCapacityShrinkAt >= opts.rateLimitCapacityShrinkIntervalMs) {
        capacity = Math.max(1, capacity - 1)
        lastCapacityShrinkAt = now
      }
      lastRateLimitAt = now
    }

    /** Wake at the earliest of: next global launch, next eligible task, recovery. */
    const wakeAt = (): number => {
      let at = nextLaunchAt
      for (const index of pending) {
        if (slots[index].eligibleAt < at) at = slots[index].eligibleAt
      }
      if (rateLimitMode) {
        const recoveryAt = lastRateLimitAt + opts.rateLimitCapacityRecoveryIntervalMs
        if (recoveryAt < at) at = recoveryAt
      }
      return at
    }

    const schedule = (): void => {
      if (finished) return
      if (signal.aborted) {
        cancelAll()
        return
      }
      if (pending.length === 0) return
      const now = opts.now()

      // Global concurrency cap (normal phase; the rate-limit phase has its own
      // capacity control below).
      if (opts.maxConcurrency > 0 && active.size >= opts.maxConcurrency) {
        wake()
        return
      }

      const index = nextLaunchable()
      if (index === undefined) {
        wake()
        return
      }

      if (rateLimitMode) {
        if (active.size >= capacity || now < nextLaunchAt) {
          wake()
          return
        }
        // One launch per pass, then the next global launch is base-delay away.
        nextLaunchAt = now + opts.rateLimitRetryBaseMs
        launchNow(index)
        return
      }

      // Normal phase: the initial burst launches back-to-back...
      if (normalLaunches < opts.initialLaunchLimit) {
        launchNow(index)
        if (normalLaunches === opts.initialLaunchLimit) {
          // The burst end arms the ramp. Under a concurrency cap, refills are
          // completion-driven (immediate); otherwise one per interval.
          nextLaunchAt = opts.maxConcurrency > 0 ? 0 : now + opts.launchIntervalMs
        }
        schedule() // continue the burst synchronously
        return
      }

      // ...then the ramp paces one launch per interval.
      if (opts.maxConcurrency > 0 || now >= nextLaunchAt) {
        launchNow(index)
        nextLaunchAt = now + opts.launchIntervalMs
        return
      }
      wake()
    }

    /** Launch one task without awaiting it. */
    const launchNow = (index: number): void => {
      pending.splice(pending.indexOf(index), 1)
      active.add(index)
      normalLaunches += 1
      setStatus(index, 'running')
      void launch(index)
    }

    /** Arm a timer at the earliest future wake point. */
    const wake = (): void => {
      if (finished || pending.length === 0) return
      const now = opts.now()
      const at = Math.max(wakeAt(), now)
      wakeTimer = opts.setTimeout(schedule, at - now)
    }

    /** First pending slot whose personal delay has elapsed, or undefined. */
    const nextLaunchable = (): number | undefined => {
      const now = opts.now()
      for (let i = 0; i < pending.length; i += 1) {
        if (slots[pending[i]].eligibleAt <= now) return pending[i]
      }
      return undefined
    }

    // Kick off the ramp (or cancel immediately).
    if (signal.aborted) {
      cancelAll()
    } else {
      signal.addEventListener('abort', () => {
        if (!finished) cancelAll()
      }, { once: true })
      schedule()
    }
    // Wait for every slot to settle (spawns are real async work; returning
    // early would hand the caller a half-empty result array).
    await allSettled
    return results as SwarmRunResult[]
  }

  /** Run one attempt with the optional per-task timeout. Never rejects. */
  private async runAttempt(slot: SlotState, signal: AbortSignal): Promise<SwarmAttemptResult> {
    const opts = this.options
    let timedOut = false
    let timer: unknown | undefined
    const timeoutSignal = new AbortController()
    const onAbort = (): void => timeoutSignal.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    if (opts.timeoutMs > 0) {
      timer = opts.setTimeout(() => {
        timedOut = true
        timeoutSignal.abort()
      }, opts.timeoutMs)
    }
    try {
      const outcome = await this.spawn(slot.task, timeoutSignal.signal)
      // A timeout abort can surface as an aborted outcome; report it as a
      // task-local failure so the batch keeps going.
      if (timedOut) {
        return {
          agentId: slot.agentId ?? outcome.agentId,
          status: 'failed',
          state: 'started',
          error: `subagent timed out after ${opts.timeoutMs}ms`,
        }
      }
      return outcome
    } catch (error) {
      return {
        agentId: slot.agentId,
        status: 'failed',
        state: 'started',
        error: timedOut ? `subagent timed out after ${opts.timeoutMs}ms` : String(error),
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) opts.clearTimeout(timer)
    }
  }
}
