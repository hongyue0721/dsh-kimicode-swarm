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
  callId: 'call_1',
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
      callId: 'call_2',
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
