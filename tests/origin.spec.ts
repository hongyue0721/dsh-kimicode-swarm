/** Exercise the actual HTTP adapter, including malformed Origin handling. */
import { describe, expect, it, vi } from 'vitest'
import { progressRoute, sameOrigin } from '../src/index.ts'
import { createProgressBroadcaster } from '../src/progress.ts'

describe('SSE Origin boundary', () => {
  it.each([
    [undefined, 'localhost:1234', true], ['http://localhost:1234', 'localhost:1234', true],
    ['http://other:1234', 'localhost:1234', false], ['http://localhost:9999', 'localhost:1234', false],
    ['null', 'localhost:1234', false], ['invalid', 'localhost:1234', false], ['http://localhost', undefined, false],
  ])('checks Origin %s against Host %s', (origin, host, allowed) => expect(sameOrigin(origin, host)).toBe(allowed))

  it('returns 403 before attaching a cross-origin response', async () => {
    const broadcaster = createProgressBroadcaster()
    const subscribe = vi.spyOn(broadcaster, 'subscribe')
    const route = progressRoute(broadcaster)
    const res = { writeHead: vi.fn(), end: vi.fn(), write: vi.fn() }
    await route.handler({ method: 'GET', headers: { origin: 'http://other', host: 'localhost' }, on: vi.fn() } as any, res as any)
    expect(res.writeHead).toHaveBeenCalledWith(403, { 'content-type': 'text/plain' })
    expect(subscribe).not.toHaveBeenCalled()
    broadcaster.close()
  })

  it('attaches same-origin GET requests and rejects other methods', async () => {
    const broadcaster = createProgressBroadcaster()
    const route = progressRoute(broadcaster)
    const res = { writeHead: vi.fn(), end: vi.fn(), write: vi.fn() }
    const req = { method: 'GET', headers: { origin: 'http://localhost', host: 'localhost' }, on: vi.fn() }
    await route.handler(req as any, res as any)
    expect(res.writeHead.mock.calls[0][0]).toBe(200)
    expect(req.on).toHaveBeenCalledWith('close', expect.any(Function))
    await route.handler({ ...req, method: 'POST' } as any, res as any)
    expect(res.writeHead.mock.calls[1][0]).toBe(405)
    broadcaster.close()
  })
})
