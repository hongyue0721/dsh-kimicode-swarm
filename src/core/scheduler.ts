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
 *   delays (3s, 6s, 12s, doubling). Capacity starts at successful normal-phase
 *   publications minus one (min 1), shrinks per later limit (at most once per 2s), and
 *   recovers +1 after 3 minutes without a limit (may launch one immediately).
 * - At most 1 task launches per pass; a rate-limited attempt that is the only
 *   unfinished task fails instead of suspending the batch.
 * - Deliberate difference from Kimi: a task fails after maxRateLimitRetries
 *   retries. Without the bound, tasks that are all permanently limited (an
 *   exhausted quota) keep each other "unfinished" and the batch never ends.
 * Host capacity:
 * - An attempt refused because the host's active-child limit is full is not a
 *   failure: the task requeues and launching pauses until a running attempt
 *   settles (or a retry delay passes when none of ours is running).
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
  status: 'queued' | 'running' | 'rate_limited' | 'completed' | 'failed' | 'aborted'
  retryAt?: number
  retries?: number
  agentId?: string
  startedAt?: number
  settledAt?: number
  toolCalls?: number
  activity?: string
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
  /** Retries one task may spend on rate limits before it fails. */
  maxRateLimitRetries?: number
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
   * host half pushes these over its SSE route; the UI renders them as live rows.
   */
  onProgress?: (entries: SwarmProgressEntry[]) => void
}

export interface ResolvedSchedulerOptions {
  initialLaunchLimit: number
  launchIntervalMs: number
  rateLimitRetryBaseMs: number
  rateLimitRetryFactor: number
  maxRateLimitRetries: number
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
    maxRateLimitRetries: options.maxRateLimitRetries ?? 8,
    rateLimitCapacityShrinkIntervalMs: options.rateLimitCapacityShrinkIntervalMs ?? 2000,
    rateLimitCapacityRecoveryIntervalMs: options.rateLimitCapacityRecoveryIntervalMs ?? 3 * 60 * 1000,
    maxConcurrency: options.maxConcurrency ?? 0,
    timeoutMs: options.timeoutMs ?? 0,
    now: options.now ?? Date.now,
    setTimeout: options.setTimeout ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return handle
    }),
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
  /** Published child id: reported on cancellation and continued by a rate-limit retry. */
  agentId: string | undefined
  /** Number of rate-limit hits this slot has taken. */
  rateLimitHits: number
  /** Current live status for the progress feed. */
  status: SwarmProgressEntry['status']
  ready: boolean
  startedAt?: number
  settledAt?: number
  toolCalls?: number
  activity?: string
}

export class SwarmScheduler {
  private readonly options: ResolvedSchedulerOptions
  private recordActivity: ((agentId: string, tool: string) => void) | undefined

  /** Only the host can attribute an observed tool result to a published child. */
  toolResult(agentId: string, tool: string): void {
    this.recordActivity?.(agentId, tool)
  }

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
      ready: false,
    }))
    /** Pending slot indexes in launch order. */
    const pending: number[] = tasks.map((_, index) => index)
    const active = new Set<number>()
    let settled = 0
    let normalLaunches = 0
    let startedSuccessCount = 0
    let globalRetryIntervalMs = opts.rateLimitRetryBaseMs
    let rateLimitMode = false
    let capacity = 1
    let nextLaunchAt = 0
    let lastRateLimitAt = 0
    let lastCapacityShrinkAt = 0
    let lastCapacityRecoveryAt = 0
    /** The host refused a launch; hold launches until one of ours settles. */
    let capacityBlocked = false
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
          ...(slot.status === 'rate_limited' ? { retryAt: Math.max(slot.eligibleAt, nextLaunchAt) } : {}),
          retries: slot.rateLimitHits,
          ...(slot.agentId === undefined ? {} : { agentId: slot.agentId }),
          ...(slot.startedAt === undefined ? {} : { startedAt: slot.startedAt }),
          ...(slot.settledAt === undefined ? {} : { settledAt: slot.settledAt }),
          ...(slot.toolCalls === undefined ? {} : { toolCalls: slot.toolCalls }),
          ...(slot.activity === undefined ? {} : { activity: slot.activity }),
        })),
      )
    }

    this.recordActivity = (agentId, tool) => {
      const slot = slots.find((entry) => entry.agentId === agentId && entry.status === 'running')
      if (slot === undefined) return
      slot.toolCalls = (slot.toolCalls ?? 0) + 1
      slot.activity = tool
      emitProgress()
    }

    const setStatus = (index: number, status: SwarmProgressEntry['status']): void => {
      slots[index].status = status
      emitProgress()
    }

    const settle = (index: number, result: SwarmRunResult): void => {
      slots[index].agentId = result.agentId
      slots[index].settledAt = opts.now()
      results[index] = {
        ...result, startedAt: slots[index].startedAt, settledAt: slots[index].settledAt,
        toolCalls: slots[index].toolCalls, activity: slots[index].activity, retries: slots[index].rateLimitHits,
      }
      setStatus(index, result.status)
      settled += 1
      if (settled === count) finish()
    }

    const finish = (): void => {
      if (finished) return
      finished = true
      this.recordActivity = undefined
      signal.removeEventListener('abort', onBatchAbort)
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
        const started = slot.agentId !== undefined
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
      slot.ready = false
      const attempt = await this.runAttempt(slot, signal, () => {
        if (finished || slot.ready) return
        slot.ready = true
        slot.startedAt ??= opts.now()
        slot.toolCalls ??= 0
        if (!rateLimitMode) startedSuccessCount += 1
        else {
          globalRetryIntervalMs = opts.rateLimitRetryBaseMs
          nextLaunchAt = opts.now() + globalRetryIntervalMs
        }
        emitProgress()
      })
      active.delete(index)
      if (finished) return
      capacityBlocked = attempt.capacityLimited === true && active.size > 0

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

      if (attempt.capacityLimited) {
        // No active attempt of ours can wake the queue, so retry on a timer.
        if (active.size === 0) slot.eligibleAt = opts.now() + opts.rateLimitRetryBaseMs
        pending.unshift(index)
        setStatus(index, 'queued')
      } else if (attempt.rateLimited) {
        slot.agentId = attempt.agentId ?? slot.agentId
        slot.rateLimitHits += 1
        const otherUnfinished = pending.length > 0 || active.size > 0
        if (!otherUnfinished || slot.rateLimitHits > opts.maxRateLimitRetries) {
          // Fail it instead of suspending the batch: nothing else can make
          // progress for it, or it has used up its retries.
          settle(index, {
            task: slot.task,
            agentId: slot.agentId,
            status: 'failed',
            state: slot.agentId === undefined ? 'not_started' : 'started',
            error: attempt.error ?? 'Provider rate limit; no other work to wait for.',
          })
        } else {
          enterRateLimitMode()
          slot.delay =
            slot.delay === 0
              ? opts.rateLimitRetryBaseMs
              : Math.min(slot.delay * opts.rateLimitRetryFactor, 5 * 60 * 1000)
          slot.eligibleAt = opts.now() + slot.delay
          if (!slot.ready) globalRetryIntervalMs = Math.max(globalRetryIntervalMs * 2, slot.delay)
          nextLaunchAt = Math.max(nextLaunchAt, opts.now() + globalRetryIntervalMs)
          pending.unshift(index)
          setStatus(index, 'rate_limited')
        }
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
        // Kimi seeds from successful publications, then immediately shrinks once.
        // Queued tasks and unpublished attempts cannot inflate the seed; next global
        // launch no earlier than the base retry delay.
        capacity = Math.max(1, Math.max(1, startedSuccessCount) - 1)
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

    /** First pending slot whose personal delay has elapsed, or undefined. */
    const nextLaunchable = (now: number): number | undefined =>
      pending.find((index) => slots[index].eligibleAt <= now)

    /** Earliest moment any pending slot's personal delay has elapsed. */
    const nextPendingReadyAt = (): number =>
      pending.reduce((at, index) => Math.min(at, slots[index].eligibleAt), Number.POSITIVE_INFINITY)

    /** Launch one task without awaiting it. */
    const launchNow = (index: number): void => {
      pending.splice(pending.indexOf(index), 1)
      active.add(index)
      normalLaunches += 1
      setStatus(index, 'running')
      void launch(index)
    }

    /** Own the single wake timer: replace it with one firing at `at`. */
    const armWake = (at: number, now: number): void => {
      if (wakeTimer !== undefined) {
        opts.clearTimeout(wakeTimer)
        wakeTimer = undefined
      }
      if (!Number.isFinite(at)) return
      wakeTimer = opts.setTimeout(() => {
        wakeTimer = undefined
        schedule()
      }, Math.max(0, at - now))
    }

    const atConcurrencyCap = (): boolean =>
      opts.maxConcurrency > 0 && active.size >= opts.maxConcurrency

    /** Burst, then one launch per interval; under a cap, refills follow completions. */
    const scheduleNormal = (now: number): void => {
      let index = nextLaunchable(now)
      while (index !== undefined && !atConcurrencyCap()) {
        const inBurst = normalLaunches < opts.initialLaunchLimit
        if (!inBurst && opts.maxConcurrency === 0 && now < nextLaunchAt) break
        launchNow(index)
        if (!inBurst || normalLaunches === opts.initialLaunchLimit) nextLaunchAt = now + opts.launchIntervalMs
        if (!inBurst && opts.maxConcurrency === 0) break
        index = nextLaunchable(now)
      }
      if (pending.length === 0 || atConcurrencyCap()) return
      armWake(Math.max(nextLaunchAt, nextPendingReadyAt()), now)
    }

    /** One launch per pass, bounded by the adaptive capacity. */
    const scheduleRateLimited = (now: number): void => {
      let recoveryAt = Math.max(lastRateLimitAt, lastCapacityRecoveryAt) + opts.rateLimitCapacityRecoveryIntervalMs
      if (now >= recoveryAt) {
        capacity += 1
        lastCapacityRecoveryAt = now
        recoveryAt = now + opts.rateLimitCapacityRecoveryIntervalMs
        nextLaunchAt = Math.min(nextLaunchAt, now)
      }
      if (active.size < capacity && now >= Math.max(nextLaunchAt, nextPendingReadyAt())) {
        launchNow(nextLaunchable(now) as number)
        nextLaunchAt = now + globalRetryIntervalMs
      }
      if (pending.length === 0) return
      armWake(
        active.size >= capacity
          ? recoveryAt
          : Math.min(Math.max(nextLaunchAt, nextPendingReadyAt()), recoveryAt),
        now,
      )
    }

    const schedule = (): void => {
      if (finished) return
      if (signal.aborted) {
        cancelAll()
        return
      }
      if (pending.length === 0 || capacityBlocked) return
      if (atConcurrencyCap()) return
      const now = opts.now()
      if (rateLimitMode) scheduleRateLimited(now)
      else scheduleNormal(now)
    }

    const onBatchAbort = (): void => { if (!finished) cancelAll() }
    // Kick off the ramp (or cancel immediately).
    if (signal.aborted) {
      cancelAll()
    } else {
      signal.addEventListener('abort', onBatchAbort, { once: true })
      schedule()
    }
    // Wait for every slot to settle (spawns are real async work; returning
    // early would hand the caller a half-empty result array).
    await allSettled
    return results as SwarmRunResult[]
  }

  /** Run one attempt with the optional per-task timeout. Never rejects. */
  private async runAttempt(slot: SlotState, signal: AbortSignal, onPublished: () => void): Promise<SwarmAttemptResult> {
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
      ;(timer as { unref?: () => void })?.unref?.()
    }
    try {
      const outcome = await this.spawn(slot.task, timeoutSignal.signal, {
        retryAgentId: slot.agentId,
        onStarted: (agentId) => {
          slot.agentId = agentId
          onPublished()
        },
      })
      // A timeout abort can surface as an aborted outcome; report it as a
      // task-local failure so the batch keeps going.
      if (timedOut) {
        return {
          agentId: slot.agentId ?? outcome.agentId,
          status: 'failed',
          state: slot.agentId !== undefined || outcome.agentId !== undefined ? 'started' : 'not_started',
          error: `subagent timed out after ${opts.timeoutMs}ms`,
        }
      }
      return outcome
    } catch (error) {
      return {
        agentId: slot.agentId,
        status: 'failed',
        state: slot.agentId !== undefined ? 'started' : 'not_started',
        error: timedOut ? `subagent timed out after ${opts.timeoutMs}ms` : String(error),
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (timer !== undefined) opts.clearTimeout(timer)
    }
  }
}
