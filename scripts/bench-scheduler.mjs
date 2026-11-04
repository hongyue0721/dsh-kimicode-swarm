#!/usr/bin/env node
/**
 * Reproducible scheduler benchmark on a virtual clock: results are deterministic
 * and take seconds to produce. It measures scheduling only. Tasks are independent
 * fakes of a fixed duration, with no model, rate limits or cost. `hostLimit` plays
 * the host's maxActiveSubagents, refusing launches the way the real host does.
 *
 * Usage: pnpm bench
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../src/core/scheduler.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: 'ESNext', target: 'ES2022' } })
const { SwarmScheduler } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function run({ tasks, durationMs, hostLimit }) {
  let now = 0
  let sequence = 0
  let pending = []
  let peak = 0
  let active = 0
  const schedule = (fn, ms) => {
    // A zero-delay timer costs at least 1ms in Node; keep virtual time moving.
    const timer = { at: now + Math.max(ms, 1), fn, id: ++sequence, dead: false }
    pending.push(timer)
    return timer
  }
  const spawn = (task, _signal, attempt) => new Promise((resolve) => {
    if (active >= hostLimit) {
      resolve({ agentId: undefined, status: 'failed', state: 'not_started', error: 'limit', capacityLimited: true })
      return
    }
    active += 1
    peak = Math.max(peak, active)
    attempt.onStarted(`child-${task.index}`)
    schedule(() => {
      active -= 1
      resolve({ agentId: `child-${task.index}`, status: 'completed', state: 'started', result: 'ok' })
    }, durationMs)
  })
  const scheduler = new SwarmScheduler(spawn, {
    now: () => now,
    setTimeout: schedule,
    clearTimeout: (timer) => { if (timer) timer.dead = true },
  })
  const list = Array.from({ length: tasks }, (_, index) => ({
    index: index + 1, kind: 'spawn', item: `item-${index}`, prompt: `prompt-${index}`,
    type: 'coder', model: undefined, resumeAgentId: undefined, description: 'bench',
  }))
  let results
  scheduler.run(list, new AbortController().signal).then((settled) => { results = settled })
  await flush()
  while (results === undefined) {
    pending = pending.filter((timer) => !timer.dead).sort((a, b) => a.at - b.at || a.id - b.id)
    const next = pending.shift()
    if (next === undefined) throw new Error('Scheduler stalled: tasks remain but no timer is armed.')
    now = next.at
    next.fn()
    await flush()
  }
  const failed = results.filter((result) => result.status !== 'completed').length
  if (failed > 0) throw new Error(`${failed} tasks failed in a run with no failing task.`)
  return { seconds: now / 1000, peak }
}

const rows = []
for (const [tasks, durationMs, hostLimit] of [
  [20, 60_000, 8], [20, 60_000, 128], [128, 60_000, 8], [128, 60_000, 128], [128, 300_000, 128],
]) {
  const { seconds, peak } = await run({ tasks, durationMs, hostLimit })
  const serial = tasks * durationMs / 1000
  rows.push({
    tasks, 'task (s)': durationMs / 1000, 'host limit': hostLimit, 'serial (s)': serial,
    'swarm (s)': seconds, 'peak concurrency': peak, speedup: `${(serial / seconds).toFixed(1)}x`,
  })
}
console.table(rows)
process.exit(0)
