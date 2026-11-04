/**
 * Progress broadcaster unit tests: SSE frame serialization, fan-out to
 * attached responses, dead-socket pruning, heartbeat writes, and teardown.
 * Responses are faked with a writable-like object recording chunks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import {
  createProgressBroadcaster,
  SWARM_PROGRESS_EVENT,
  SWARM_PROGRESS_ROUTE,
  serializeEnd,
  serializeFrame,
  serializeHeartbeat,
  type SwarmProgressFrame,
} from '../src/progress.ts'

/** A minimal ServerResponse stand-in recording writes. */
function fakeResponse(overrides: Partial<{ destroyed: boolean; writableEnded: boolean }> = {}) {
  const chunks: string[] = []
  return {
    chunks,
    response: {
      destroyed: overrides.destroyed ?? false,
      writableEnded: overrides.writableEnded ?? false,
      write(chunk: string) {
        chunks.push(chunk)
        return true
      },
    } as unknown as ServerResponse,
  }
}

const frame: SwarmProgressFrame = {
  callId: 'call_1', sessionId: 'parent',
  subagents: [
    { index: 1, item: '任务一', type: 'coder', model: null, status: 'running' },
    { index: 2, item: '任务二', type: 'coder', model: null, status: 'queued' },
  ],
}

describe('serializeFrame', () => {
  it('emits the progress SSE event with JSON data', () => {
    const record = serializeFrame(frame)
    expect(record.startsWith(`event: ${SWARM_PROGRESS_EVENT}\ndata: `)).toBe(true)
    expect(record.endsWith('\n\n')).toBe(true)
    const data = JSON.parse(record.split('\ndata: ')[1].slice(0, -2))
    expect(data).toEqual(frame)
  })

  it('escapes embedded newlines so one frame is one SSE record', () => {
    const withNewline: SwarmProgressFrame = {
      callId: 'call_2', sessionId: 'parent',
      subagents: [{ index: 1, item: '多行\n任务', type: null, model: null, status: 'queued' }],
    }
    const record = serializeFrame(withNewline)
    expect(record.split('\n\n').length).toBe(2)
  })
})

describe('serializeHeartbeat', () => {
  it('emits the ping event with an empty object', () => {
    expect(serializeHeartbeat()).toBe('event: ping\ndata: {}\n\n')
  })
})

describe('createProgressBroadcaster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fans one frame out to every attached response', () => {
    const broadcaster = createProgressBroadcaster()
    const a = fakeResponse()
    const b = fakeResponse()
    broadcaster.subscribe(a.response)
    broadcaster.subscribe(b.response)
    broadcaster.publish(frame)
    expect(a.chunks).toEqual([serializeFrame(frame)])
    expect(b.chunks).toEqual([serializeFrame(frame)])
    broadcaster.close()
  })

  it('detaching stops delivery to that response only', () => {
    const broadcaster = createProgressBroadcaster()
    const a = fakeResponse()
    const b = fakeResponse()
    const detachA = broadcaster.subscribe(a.response)
    broadcaster.subscribe(b.response)
    detachA()
    broadcaster.publish(frame)
    expect(a.chunks).toEqual([])
    expect(b.chunks).toEqual([serializeFrame(frame)])
    broadcaster.close()
  })

  it('prunes destroyed sockets instead of writing to them', () => {
    const broadcaster = createProgressBroadcaster()
    const dead = fakeResponse({ destroyed: true })
    const alive = fakeResponse()
    broadcaster.subscribe(dead.response)
    broadcaster.subscribe(alive.response)
    broadcaster.publish(frame)
    expect(dead.chunks).toEqual([])
    expect(alive.chunks).toEqual([serializeFrame(frame)])
    broadcaster.close()
  })

  it('writes heartbeats on the shared timer and prunes dead sockets', () => {
    const broadcaster = createProgressBroadcaster(1000)
    const a = fakeResponse()
    broadcaster.subscribe(a.response)
    vi.advanceTimersByTime(1000)
    expect(a.chunks).toEqual([serializeHeartbeat()])
    broadcaster.close()
  })

  it('close stops heartbeats and clears attachments', () => {
    const broadcaster = createProgressBroadcaster(1000)
    const a = fakeResponse()
    broadcaster.subscribe(a.response)
    broadcaster.close()
    vi.advanceTimersByTime(5000)
    expect(a.chunks).toEqual([])
    // Publishing after close is a no-op (no attachments remain).
    broadcaster.publish(frame)
    expect(a.chunks).toEqual([])
  })
})

describe('SWARM_PROGRESS_ROUTE', () => {
  it('is the documented same-origin route the browser half connects to', () => {
    expect(SWARM_PROGRESS_ROUTE).toBe('/swarm-events')
  })
})

describe('running-call replay', () => {
  const frame = { callId: 'call-1', sessionId: 'parent', subagents: [] }

  function recorder(): { response: ServerResponse; writes: string[] } {
    const writes: string[] = []
    const response = {
      destroyed: false,
      writableEnded: false,
      write: (record: string) => writes.push(record),
    } as unknown as ServerResponse
    return { response, writes }
  }

  it('replays the latest frame of a running call to a late subscriber', () => {
    const broadcaster = createProgressBroadcaster()
    broadcaster.publish(frame)
    const { response, writes } = recorder()
    broadcaster.subscribe(response)
    expect(writes).toEqual([serializeFrame(frame)])
    broadcaster.close()
  })

  it('stops replaying a finished call and announces its end', () => {
    const broadcaster = createProgressBroadcaster()
    const first = recorder()
    broadcaster.subscribe(first.response)
    broadcaster.publish(frame)
    broadcaster.finish('call-1', 'parent')
    expect(first.writes.at(-1)).toBe(serializeEnd('call-1', 'parent'))
    const late = recorder()
    broadcaster.subscribe(late.response)
    expect(late.writes).toEqual([])
    broadcaster.close()
  })
})

describe('v2 progress transport', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces ordinary full snapshots for 250ms while preserving the newest data', () => {
    const broadcaster = createProgressBroadcaster()
    const { response, chunks } = fakeResponse()
    broadcaster.subscribe(response)
    broadcaster.publish(frame)
    const updated = { ...frame, subagents: frame.subagents.map((entry) => ({ ...entry, toolCalls: 12, activity: 'Read' })) }
    broadcaster.publish(updated)
    broadcaster.publish({ ...updated, subagents: updated.subagents.map((entry) => ({ ...entry, toolCalls: 13 })) })
    expect(chunks).toHaveLength(1)
    vi.advanceTimersByTime(249)
    expect(chunks).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toContain('"toolCalls":13')
    broadcaster.close()
  })

  it('immediately publishes every terminal transition and cancels a stale delayed frame', () => {
    const broadcaster = createProgressBroadcaster()
    const { response, chunks } = fakeResponse()
    broadcaster.subscribe(response)
    broadcaster.publish(frame)
    broadcaster.publish({ ...frame, subagents: frame.subagents.map((entry) => ({ ...entry, toolCalls: 1 })) })
    const terminal = { ...frame, subagents: frame.subagents.map((entry) => ({ ...entry, status: 'completed' as const, settledAt: Date.now() })) }
    broadcaster.publish(terminal)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]).toBe(serializeFrame(terminal))
    vi.advanceTimersByTime(250)
    expect(chunks).toHaveLength(2)
    broadcaster.close()
  })

  it('caps item text at 200 characters on the wire without mutating the source', () => {
    const long = { ...frame, subagents: [{ ...frame.subagents[0], item: 'x'.repeat(500), agentId: 'child', retries: 2, retryAt: 123, startedAt: 100, settledAt: 200, toolCalls: 8, activity: 'Read' }] }
    const decoded = JSON.parse(serializeFrame(long).split('data: ')[1])
    expect(decoded.sessionId).toBe('parent')
    expect(decoded.subagents[0]).toMatchObject({ item: 'x'.repeat(200), agentId: 'child', retries: 2, retryAt: 123, startedAt: 100, settledAt: 200, toolCalls: 8, activity: 'Read' })
    expect(long.subagents[0].item).toHaveLength(500)
  })

  it('replays all known active modes and excludes sessions that have been turned off', () => {
    const broadcaster = createProgressBroadcaster()
    broadcaster.mode({ sessionId: 'a', active: true, trigger: 'manual' })
    broadcaster.mode({ sessionId: 'b', active: true, trigger: 'task' })
    broadcaster.mode({ sessionId: 'b', active: false, trigger: null })
    broadcaster.mode({ sessionId: 'c', active: true, trigger: 'task' })
    const { response, chunks } = fakeResponse()
    broadcaster.subscribe(response)
    expect(chunks).toHaveLength(2)
    expect(chunks.every((chunk) => chunk.startsWith('event: mode\n'))).toBe(true)
    expect(chunks.join('')).toContain('"sessionId":"a"')
    expect(chunks.join('')).toContain('"sessionId":"c"')
    expect(chunks.join('')).not.toContain('"sessionId":"b"')
    broadcaster.close()
  })
})

describe('session-scoped call identities', () => {
  it('keeps identical call ids from different sessions separate through settlement', () => {
    const broadcaster = createProgressBroadcaster()
    broadcaster.publish({ ...frame, sessionId: 'a' })
    broadcaster.publish({ ...frame, sessionId: 'b' })
    broadcaster.finish(frame.callId, 'a')
    const { response, chunks } = fakeResponse()
    broadcaster.subscribe(response)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('"sessionId":"b"')
    broadcaster.close()
  })
  it('truncates at Unicode character boundaries', () => {
    const wire = serializeFrame({ ...frame, subagents: [{ ...frame.subagents[0], item: '任务𠮷'.repeat(100) }] })
    const item = JSON.parse(wire.split('data: ')[1]).subagents[0].item
    expect(Array.from(item)).toHaveLength(200)
    expect(item).toBe(Array.from('任务𠮷'.repeat(100)).slice(0, 200).join(''))
  })
})
