/** Browser stream lifecycle: transient drops stay open, a closed stream reconnects with backoff. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openProgressStream } from '../src/client/progress-stream.ts'
import { getSwarmProgress, publishSwarmProgress } from '../src/client/progress-store.ts'

const CONNECTING = 0
const CLOSED = 2

class FakeEventSource {
  readyState = CONNECTING
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, (event: { data: string }) => void>()

  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(name, listener)
  }

  emit(name: string, data: unknown): void {
    this.listeners.get(name)?.({ data: JSON.stringify(data) })
  }

  fail(readyState: number): void {
    this.readyState = readyState
    this.onerror?.()
  }

  close(): void {
    this.closed = true
  }
}

function open() {
  const sources: FakeEventSource[] = []
  const dispose = openProgressStream(() => {
    const source = new FakeEventSource()
    sources.push(source)
    return source as unknown as EventSource
  })
  return { sources, dispose }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('openProgressStream', () => {
  it('leaves a transient drop to the browser reconnect', () => {
    const { sources, dispose } = open()
    sources[0].fail(CONNECTING)
    vi.advanceTimersByTime(120_000)
    expect(sources).toHaveLength(1)
    expect(sources[0].closed).toBe(false)
    dispose()
  })

  it('reopens a closed stream with growing delays, reset by a successful open', () => {
    const { sources, dispose } = open()
    sources[0].fail(CLOSED)
    vi.advanceTimersByTime(2999)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(2)
    sources[1].fail(CLOSED)
    vi.advanceTimersByTime(5999)
    expect(sources).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sources).toHaveLength(3)
    sources[2].onopen?.()
    sources[2].fail(CLOSED)
    vi.advanceTimersByTime(3000)
    expect(sources).toHaveLength(4)
    dispose()
  })

  it('cancels a pending reconnect and closes the stream on dispose', () => {
    const { sources, dispose } = open()
    sources[0].fail(CLOSED)
    dispose()
    vi.advanceTimersByTime(120_000)
    expect(sources).toHaveLength(1)
    expect(sources[0].closed).toBe(true)
  })

  it('publishes frames and releases a call when the host announces its end', () => {
    const { sources, dispose } = open()
    sources[0].emit('progress', { callId: 'call-1', sessionId: 'parent', subagents: [] })
    expect(getSwarmProgress('call-1', 'parent')).toEqual([])
    sources[0].emit('progress-end', { callId: 'call-1', sessionId: 'parent' })
    expect(getSwarmProgress('call-1', 'parent')).toBeUndefined()
    dispose()
  })

  it('ignores a malformed end record', () => {
    publishSwarmProgress('call-2', [], 'parent')
    const { sources, dispose } = open()
    expect(() => sources[0].emit('progress-end', null)).not.toThrow()
    expect(getSwarmProgress('call-2', 'parent')).toEqual([])
    dispose()
  })
})

describe('mode and scoped cleanup events', () => {
  it('handles mode events and clears stale modes when reconnecting', async () => {
    const { getSwarmMode, publishSwarmMode } = await import('../src/client/progress-store.ts')
    publishSwarmMode({ sessionId: 'stale', active: true, trigger: 'manual' })
    const { sources, dispose } = open()
    sources[0].onopen?.()
    expect(getSwarmMode('stale')).toBeUndefined()
    sources[0].emit('mode', { sessionId: 'parent', active: true, trigger: 'task' })
    expect(getSwarmMode('parent')).toEqual({ sessionId: 'parent', active: true, trigger: 'task' })
    sources[0].emit('mode', { sessionId: 'parent', active: false, trigger: 'task' })
    expect(getSwarmMode('parent')?.active).toBe(true)
    sources[0].emit('mode', { sessionId: 'parent', active: false, trigger: null })
    expect(getSwarmMode('parent')).toBeUndefined()
    dispose()
  })
  it('releases only the session named by a valid end frame', () => {
    publishSwarmProgress('shared-call', [], 'a')
    publishSwarmProgress('shared-call', [], 'b')
    const { sources, dispose } = open()
    sources[0].emit('progress-end', { callId: 'shared-call', sessionId: 'a' })
    expect(getSwarmProgress('shared-call', 'a')).toBeUndefined()
    expect(getSwarmProgress('shared-call', 'b')).toEqual([])
    sources[0].emit('progress-end', { callId: 'shared-call' })
    expect(getSwarmProgress('shared-call', 'b')).toEqual([])
    dispose()
  })
})
