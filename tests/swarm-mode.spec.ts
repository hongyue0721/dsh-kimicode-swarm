/** Strict plugin record folding and reload compatibility without an LLM or web server. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { foldMode, initialMode, MODE_RECORD, parseMode, SwarmModeController } from '../src/swarm-mode.ts'

describe('mode record fold', () => {
  it('validates mode invariants instead of supplying missing facts', () => {
    for (const value of [{}, { active: true, trigger: null, everActive: true }, { active: false, trigger: 'manual', everActive: true }, { active: true, trigger: 'task', everActive: false }, null]) {
      expect(() => parseMode(value)).toThrow('Invalid swarm mode record')
    }
  })
  it('round-trips ignorable plugin records through JSON and restores the same state', () => {
    const session = Session.create(SessionId('mode-round-trip'))
    appendPluginRecord(session, MODE_RECORD, { active: true, trigger: 'manual', everActive: true })
    const events = JSON.parse(JSON.stringify(session.snapshotEvents()))
    const restored = Session.create(SessionId('restored-mode'), events)
    expect(events[0].ignorable).toBe(true)
    expect(restored.snapshotEvents().reduce(foldMode, initialMode())).toEqual({ active: true, trigger: 'manual', everActive: true })
  })
  it('preserves the state reference for unrelated events', () => {
    const session = Session.create(SessionId('unrelated'))
    appendPluginRecord(session, 'plugin:dsh-kimicode-swarm/mode', { active: false, trigger: null, everActive: false })
    const state = initialMode()
    const unrelated = { ...session.snapshotEvents()[0], type: 'plugin:another-plugin/record' } as any
    expect(foldMode(state, unrelated)).toBe(state)
  })
  it('registers with the real SessionProjectionRegistry and reads through the handle without deprecation warnings', async () => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.set('sessionProjections', new SessionProjectionRegistry(ctx))
    ;(ctx as any).systemPrompt = { context: vi.fn(() => () => {}) }
    const frames: unknown[] = []
    const controller = new SwarmModeController(ctx, (frame) => frames.push(frame))
    await controller.ready
    const sessions = new SessionStore(ctx)
    const session = sessions.create()
    expect(controller.get(session)).toEqual(initialMode())
    expect(controller.set(session, 'manual')).toBe(true)
    expect(controller.get(session)).toEqual({ active: true, trigger: 'manual', everActive: true })
    expect(warn).not.toHaveBeenCalled()
    expect(frames.at(-1)).toEqual({ sessionId: session.id, active: true, trigger: 'manual' })
  })
})
