/**
 * 宿主适配层测试：用假 ctx 驱动 swarm_batch，覆盖 rc.5 子 Agent 激活契约
 * （caller 投递、取消走 dispose、续做走 sendMessage 与 subagent/end）、
 * 结构化失败信号（限流、并发上限）、取消后结果的交付，以及配置读取。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import { foldMode, initialMode, MODE_RECORD } from '../src/swarm-mode.ts'
import { apply, type Config, type SwarmModelMappingRow } from '../src/index.ts'

type Listener = (...args: any[]) => unknown

function volatile<T>(value: T): { get(): any } {
  return { get: () => value }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    requireSwarmMode: volatile(false),
    announceToAgent: true,
    timeoutMs: volatile(0),
    maxConcurrency: volatile(0),
    modelMappingEnabled: volatile(false),
    modelMapping: volatile([] as SwarmModelMappingRow[]),
    ...overrides,
  } as Config
}

function activationOf(childId: string, result: unknown = { stopReason: 'completed', output: [{ type: 'text', text: `done ${childId}` }] }) {
  return { childId, result: Promise.resolve(result), dispose: vi.fn(async () => {}) }
}

function setup(config: Config = makeConfig()) {
  let tool: any
  let projection: any
  const parent: any = { id: 'parent' }
  const stateOf = (session: Session) => session.snapshotEvents().reduce(projection.apply, projection.init())
  const services: Record<string, any> = { sessionProjections: {
    register: (definition: any) => {
      projection = definition
      return Promise.resolve({ stateOf, readerFor: (session: Session) => () => stateOf(session), dispose: async () => {} })
    },
    stateOf,
  } }
  const listeners = new Map<string, Set<Listener>>()
  const subagents = {
    getProvider: vi.fn(() => ({})),
    resolveMaxDepth: vi.fn(() => 1),
    startActivation: vi.fn(async (spec: any): Promise<any> => activationOf(`child-${spec.label}`)),
    sendMessage: vi.fn(async (..._args: any[]): Promise<any> => 'message-id'),
    interrupt: vi.fn(),
  }
  const ctx: any = {
    get: (name: string) => services[name],
    effect: vi.fn((factory: () => unknown) => factory()),
    on: vi.fn((name: string, listener: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => listeners.get(name)!.delete(listener)
    }),
    logger: { warn: vi.fn() },
    systemPrompt: { context: vi.fn(() => () => {}), section: vi.fn(() => () => {}) },
    tools: {
      register: vi.fn((definition: any) => {
        tool = definition
        return () => {}
      }),
    },
    commands: { register: vi.fn(() => () => {}) },
    webServer: { register: vi.fn(() => () => {}) },
    subagents,
  }
  const ready = apply(ctx, config)
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  const execute = (args: unknown, signal: AbortSignal = new AbortController().signal) =>
    tool.execute(args, { agent: parent, callId: 'call-1', signal })
  const text = (args: unknown, value: unknown): string => tool.output.render(args, value)[0].text
  const run = async (args: unknown, signal?: AbortSignal): Promise<string> => text(args, await execute(args, signal))
  const requestError = (agentId: string, code: string, message: string) =>
    emit('agent/request-error', { agent: { id: agentId }, failure: { code, message } }, () => undefined)
  return { ctx, parent, services, subagents, execute, run, emit, requestError, tool: () => tool, listeners, ready }
}

const batch = { description: 'd', prompt_template: 'do {{item}}', items: ['a', 'b'] }

describe('apply', () => {
  it('registers nothing when the plugin is disabled', () => {
    const { ctx } = setup(makeConfig({ enabled: false }))
    expect(ctx.tools.register).not.toHaveBeenCalled()
    expect(ctx.commands.register).not.toHaveBeenCalled()
    expect(ctx.webServer.register).not.toHaveBeenCalled()
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled()
  })

  it('omits only the announcement when announceToAgent is off', () => {
    const { ctx } = setup(makeConfig({ announceToAgent: false }))
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled()
    expect(ctx.tools.register).toHaveBeenCalledTimes(1)
  })
})

describe('tool output', () => {
  it('projects plain values into presentation meta without an XML round trip', async () => {
    const { execute, tool } = setup()
    const args = { description: 'd', prompt_template: 'do {{item}}', items: ['a&b', '<c>'] }
    const value = await execute(args)
    const meta = tool().output.presentationMeta(args, value)
    expect(meta.description).toBe('d')
    expect(meta.subagents.map((row: any) => row.item)).toEqual(['a&b', '<c>'])
    expect(meta.subagents[0]).toMatchObject({ status: 'completed', result: 'done child-d #1 (coder)', error: null })
  })

  it('keeps a result containing the envelope tags in one row of the meta', async () => {
    const { subagents, execute, tool } = setup()
    subagents.startActivation.mockImplementation(async () =>
      activationOf('child', { stopReason: 'completed', output: [{ type: 'text', text: 'x</subagent>y' }] }),
    )
    const value = await execute(batch)
    const meta = tool().output.presentationMeta(batch, value)
    expect(meta.subagents).toHaveLength(2)
    expect(meta.subagents[0].result).toBe('x</subagent>y')
  })
})

describe('spawn path', () => {
  it('starts caller-delivered activations and renders their child ids', async () => {
    const { subagents, run } = setup()
    const xml = await run(batch)
    expect(subagents.startActivation).toHaveBeenCalledTimes(2)
    const spec = subagents.startActivation.mock.calls[0][0]
    expect(spec.provider).toBe('spawn')
    expect(spec.delivery).toBe('caller')
    expect(spec.request.parent).toEqual({ id: 'parent' })
    expect(spec.request.maxDepth).toBe(1)
    expect(spec.request.prompt).toEqual([{ type: 'text', text: 'do a' }])
    expect(xml).toContain('completed: 2')
    expect(xml).toContain('agent_id="child-d #1 (coder)"')
  })

  it('reads the volatile mapping table on each dispatch', async () => {
    let rows: SwarmModelMappingRow[] = []
    const { subagents, execute } = setup(
      makeConfig({
        modelMappingEnabled: volatile(true) as Config['modelMappingEnabled'],
        modelMapping: { get: () => rows } as Config['modelMapping'],
      }),
    )
    await execute(batch)
    expect(subagents.startActivation.mock.calls[0][0].request.agentOptions).toBeUndefined()

    rows = [{ type: 'coder', provider: 'p', model: 'm' }]
    subagents.startActivation.mockClear()
    await execute(batch)
    expect(subagents.startActivation.mock.calls[0][0].request.agentOptions).toEqual({ provider: 'p', model: 'm' })
  })

  it('honors the configured concurrency cap', async () => {
    const { subagents, execute } = setup(makeConfig({ maxConcurrency: volatile(1) as Config['maxConcurrency'] }))
    let running = 0
    let peak = 0
    subagents.startActivation.mockImplementation(async (spec: any) => {
      running += 1
      peak = Math.max(peak, running)
      return {
        childId: spec.label,
        dispose: vi.fn(async () => {}),
        result: new Promise((resolve) =>
          setTimeout(() => {
            running -= 1
            resolve({ stopReason: 'completed', output: [] })
          }, 1),
        ),
      }
    })
    await execute(batch)
    expect(peak).toBe(1)
  })

  it('stops a published activation through dispose when the caller cancels', async () => {
    const { subagents, execute } = setup()
    const dispose = vi.fn(async () => {})
    subagents.startActivation.mockImplementation(async () => ({
      childId: 'child',
      result: new Promise(() => {}),
      dispose,
    }))
    const controller = new AbortController()
    const running = execute(batch, controller.signal)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    controller.abort()
    await expect(running).rejects.toThrow()
    expect(dispose).toHaveBeenCalled()
  })

  it('delivers finished work and child ids through the error when cancelled', async () => {
    const { subagents, execute } = setup()
    subagents.startActivation
      .mockImplementationOnce(async () => activationOf('finished'))
      .mockImplementationOnce(async () => ({ childId: 'unfinished', result: new Promise(() => {}), dispose: vi.fn(async () => {}) }))
    const controller = new AbortController()
    const running = execute(batch, controller.signal)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    const error: Error = await running.catch((caught: Error) => caught)
    expect(error.message).toContain('completed: 1')
    expect(error.message).toContain('done finished')
    expect(error.message).toContain('agent_id="unfinished"')
    expect(error.message).toContain('outcome="aborted"')
  })

  it('reports a start refusal as a never-started failure', async () => {
    const { subagents, run } = setup()
    subagents.startActivation.mockRejectedValue(new Error('provider unavailable'))
    const xml = await run(batch)
    expect(xml).toContain('failed: 2')
    expect(xml).toContain('state="not_started"')
    expect(xml).toContain('provider unavailable')
  })

  it('treats a host capacity refusal as back-pressure, not failure', async () => {
    const { subagents, run } = setup()
    subagents.startActivation
      .mockImplementationOnce(async (spec: any) => activationOf(spec.label))
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('subagent limit reached'), { code: 'ACTIVATION_LIMIT_REACHED' })
      })
    const xml = await run(batch)
    expect(subagents.startActivation).toHaveBeenCalledTimes(3)
    expect(xml).toContain('completed: 2')
  })

  it('does not mistake digits in an ordinary error for a rate limit', async () => {
    const { subagents, run } = setup()
    subagents.startActivation.mockRejectedValue(new Error('task 14290 failed'))
    const xml = await run(batch)
    expect(subagents.startActivation).toHaveBeenCalledTimes(2)
    expect(xml).toContain('failed: 2')
  })
})

describe('model failures', () => {
  it('retries a rate-limited child by continuing it', async () => {
    vi.useFakeTimers()
    try {
      const harness = setup()
      const { subagents, execute, emit, requestError } = harness
      subagents.startActivation
        .mockImplementationOnce(async () => {
          requestError('limited', 'RATE_LIMIT', '429 slow down')
          return activationOf('limited', { stopReason: 'error', output: [] })
        })
        .mockImplementationOnce(async (spec: any) => activationOf(spec.label))
      const running = execute(batch)
      await vi.advanceTimersByTimeAsync(3000)
      expect(subagents.sendMessage).toHaveBeenCalledTimes(1)
      const [, childId, content] = subagents.sendMessage.mock.calls[0]
      expect(childId).toBe('limited')
      expect(content).toEqual([{ type: 'text', text: 'continue' }])
      await vi.advanceTimersByTimeAsync(0)
      emit('subagent/end', { id: 'limited', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'recovered' }] })
      await vi.advanceTimersByTimeAsync(0)
      const value = await running
      expect(value.subagents.map((row: any) => row.status)).toEqual(['completed', 'completed'])
      expect(value.subagents[0].result).toBe('recovered')
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces the failure message of a non-rate-limit stop without retrying', async () => {
    const { subagents, run, requestError } = setup()
    subagents.startActivation.mockImplementation(async (spec: any) => {
      requestError(spec.label, 'AUTH', 'invalid api key')
      return activationOf(spec.label, { stopReason: 'error', output: [] })
    })
    const xml = await run(batch)
    expect(subagents.sendMessage).not.toHaveBeenCalled()
    expect(xml).toContain('subagent stopped: error (invalid api key)')
  })

  it('removes its failure listener when the batch ends', async () => {
    const { execute, listeners } = setup()
    await execute(batch)
    expect(listeners.get('agent/request-error')?.size).toBe(0)
  })
})

describe('resume path', () => {
  const resumeArgs = { description: 'd', resume_agent_ids: { 'child-1': 'continue' } }

  it('delivers through sendMessage and settles on the matching end edge', async () => {
    const { subagents, run, emit } = setup()
    const running = run(resumeArgs)
    await vi.waitFor(() => expect(subagents.sendMessage).toHaveBeenCalledTimes(1))
    expect(subagents.startActivation).not.toHaveBeenCalled()
    const [sender, childId, content] = subagents.sendMessage.mock.calls[0]
    expect(sender).toEqual({ id: 'parent' })
    expect(childId).toBe('child-1')
    expect(content).toEqual([{ type: 'text', text: 'continue' }])

    emit('subagent/end', { id: 'someone-else', stopReason: 'error' })
    emit('subagent/end', { id: 'child-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'resumed' }] })
    const xml = await running
    expect(xml).toContain('completed: 1')
    expect(xml).toContain('mode="resume"')
    expect(xml).toContain('>resumed</subagent>')
  })

  it('interrupts the child when the caller cancels during its turn', async () => {
    const { subagents, execute } = setup()
    const controller = new AbortController()
    const running = execute(resumeArgs, controller.signal)
    await vi.waitFor(() => expect(subagents.sendMessage).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    controller.abort()
    const error: Error = await running.catch((caught: Error) => caught)
    expect(error.message).toContain('aborted: 1')
    expect(error.message).toContain('agent_id="child-1"')
    await vi.waitFor(() =>
      expect(subagents.interrupt).toHaveBeenCalledWith('child-1', { kind: 'ancestor', agent: { id: 'parent' } }),
    )
  })

  it('reports a refused delivery as a failure on that child', async () => {
    const { subagents, run } = setup()
    subagents.sendMessage.mockRejectedValue(new Error('subagent is unavailable'))
    const xml = await run(resumeArgs)
    expect(xml).toContain('failed: 1')
    expect(xml).toContain('subagent is unavailable')
  })
})

async function withSession(config: Config) {
  const harness = setup(config)
  await harness.ready
  const sessions = new SessionStore(new Context())
  harness.parent.session = sessions.create()
  harness.parent.steer = vi.fn()
  const command = (rawInput: string) => harness.ctx.commands.register.mock.calls[0][0].handler({ agent: harness.parent, rawInput, attachments: [] })
  return { ...harness, sessions, command }
}

describe('user-owned swarm mode', () => {
  const protectedConfig = () => makeConfig({ requireSwarmMode: volatile(true) as Config['requireSwarmMode'] })

  it('rejects before any spawn or message when the user has not enabled mode', async () => {
    const h = await withSession(protectedConfig())
    await expect(h.execute(batch)).rejects.toThrow('Only the user')
    expect(h.subagents.startActivation).not.toHaveBeenCalled()
    expect(h.subagents.sendMessage).not.toHaveBeenCalled()
  })

  it('supports on/off, repeated on, toggling and manual persistence across turn end', async () => {
    const h = await withSession(protectedConfig())
    expect(h.command('on').text).toContain('several times')
    const before = h.parent.session.seq
    expect(h.command('on').text).toContain('already on')
    expect(h.parent.session.seq).toBe(before)
    h.parent.session.append('turn/start', { turn: 1 })
    h.parent.session.append('turn/end', { turn: 1, reason: 'completed' })
    await expect(h.execute(batch)).resolves.toHaveProperty('subagents')
    expect(h.command('off').text).toBe('Swarm mode off.')
    await expect(h.execute(batch)).rejects.toThrow('/swarm on')
    expect(h.command('off').text).toContain('already off')
    expect(h.command('').text).toContain('Swarm mode on')
    expect(h.command('').text).toBe('Swarm mode off.')
  })

  it('sends a task and automatically exits at turn end without changing the static prompt', async () => {
    const h = await withSession(protectedConfig())
    h.command('review these files')
    expect(h.parent.steer).toHaveBeenCalledTimes(1)
    expect(h.parent.steer.mock.calls[0][0].content).toEqual([{ type: 'text', text: 'review these files' }])
    const dynamic = h.ctx.systemPrompt.context.mock.calls[0][0].text
    expect(dynamic({ agent: h.parent })).toContain('Swarm mode is active')
    expect(dynamic({ agent: h.parent })).toContain('approval policy never')
    expect(dynamic({ agent: h.parent })).toContain('non-overlapping')
    h.parent.session.append('turn/start', { turn: 1 })
    h.parent.session.append('turn/end', { turn: 1, reason: 'completed' })
    h.emit('session/event', h.parent.session, h.parent.session.snapshotEvents().at(-1))
    expect(dynamic({ agent: h.parent })).toContain('Swarm mode has ended')
    expect(h.ctx.systemPrompt.section).toHaveBeenCalledTimes(1)
    await expect(h.execute(batch)).rejects.toThrow('/swarm on')
  })

  it('restores manual mode from plugin records but denies fork-created subagents', async () => {
    const h = await withSession(protectedConfig())
    h.command('on')
    const seed = JSON.parse(JSON.stringify(h.parent.session.snapshotEvents()))
    h.parent.session = h.sessions.create(undefined, { seed })
    await expect(h.execute(batch)).resolves.toHaveProperty('subagents')
    h.subagents.startActivation.mockClear()
    h.parent.session = h.sessions.create(undefined, { seed, meta: { origin: 'subagent', delegationDepth: 1 } })
    await expect(h.execute(batch)).rejects.toThrow('/swarm on')
    expect(h.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('retains legacy autonomous dispatch when requireSwarmMode is false', async () => {
    const h = await withSession(makeConfig())
    await expect(h.execute(batch)).resolves.toHaveProperty('subagents')
    expect(h.subagents.startActivation).toHaveBeenCalledTimes(2)
  })

  it('declares an exclusive sibling scheduling barrier', () => {
    const h = setup()
    expect(h.tool().isConcurrencySafe(batch)).toBe(false)
    expect(h.tool().description).toContain('exclusively')
    expect(h.tool().description).not.toContain('Prefer parallel swarm dispatch over sequential work')
  })
})

describe('fork and preset dispatch', () => {
  it('uses fork and ignores mapping without passing agentOptions or agentPreset', async () => {
    const h = setup(makeConfig({ modelMappingEnabled: volatile(true) as Config['modelMappingEnabled'],
      modelMapping: volatile([{ type: 'coder', provider: 'p', model: 'mapped' }]) as Config['modelMapping'] }))
    await h.execute({ ...batch, fork: true })
    expect(h.subagents.getProvider).toHaveBeenCalledWith('fork')
    for (const [spec] of h.subagents.startActivation.mock.calls) {
      expect(spec.provider).toBe('fork')
      expect(spec.request).not.toHaveProperty('agentOptions')
      expect(spec.request).not.toHaveProperty('agentPreset')
    }
  })

  it('rejects a missing fork provider before starting anything', async () => {
    const h = setup()
    h.subagents.getProvider.mockReturnValue(undefined as any)
    await expect(h.execute({ ...batch, fork: true })).rejects.toThrow('fork provider is unavailable')
    expect(h.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('inherits the parent preset when no explicit type is provided', async () => {
    const h = setup()
    h.services.agentPresets = { list: vi.fn(async () => [{ id: 'coder' }]) }
    await h.execute(batch)
    expect(h.services.agentPresets.list).toHaveBeenCalledTimes(1)
    expect(h.subagents.startActivation.mock.calls[0][0].request).not.toHaveProperty('agentPreset')
  })

  it('awaits the roster and combines an explicit model with a real preset', async () => {
    const h = setup()
    h.services.agentPresets = { list: vi.fn(async () => [{ id: 'review' }]) }
    await h.execute({ ...batch, subagent_type: 'review', model: 'chosen' })
    expect(h.subagents.startActivation.mock.calls[0][0].request).toMatchObject({ agentPreset: 'review', agentOptions: { model: 'chosen' } })
  })

  it('uses mapping-only labels without selecting an agent preset', async () => {
    const h = setup(makeConfig({ modelMappingEnabled: volatile(true) as Config['modelMappingEnabled'],
      modelMapping: volatile([{ type: 'review', provider: 'p', model: 'mapped' }]) as Config['modelMapping'] }))
    await h.execute({ ...batch, subagent_type: 'review' })
    const request = h.subagents.startActivation.mock.calls[0][0].request
    expect(request).not.toHaveProperty('agentPreset')
    expect(request.agentOptions).toEqual({ provider: 'p', model: 'mapped' })
  })

  it('lists both catalogs when an explicit type is unknown', async () => {
    const h = setup(makeConfig({ modelMapping: volatile([{ type: 'label', provider: '', model: 'm' }]) as Config['modelMapping'] }))
    h.services.agentPresets = { list: async () => [{ id: 'review' }] }
    await expect(h.execute({ ...batch, items: [{ item: 'a', type: 'missing' }, 'b'] })).rejects.toThrow('Available preset ids: review. Mapping types: label.')
    expect(h.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('does not reinterpret an unknown explicit type when the registry is absent', async () => {
    const h = setup()
    await expect(h.execute({ ...batch, subagent_type: 'missing' })).rejects.toThrow('Available preset ids: (none)')
    expect(h.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('reports preset activation failures instead of treating the id as a label', async () => {
    const h = setup()
    h.services.agentPresets = { list: async () => [{ id: 'review', broken: 'missing tools' }] }
    await expect(h.execute({ ...batch, subagent_type: 'review' })).rejects.toThrow('missing tools')
    expect(h.subagents.startActivation).not.toHaveBeenCalled()
  })
})

describe('child tool progress observation', () => {
  it('counts only published batch children and removes the observer on completion', async () => {
    const h = setup()
    h.subagents.startActivation.mockImplementation(async (spec: any) => ({
      childId: spec.label, dispose: vi.fn(async () => {}),
      result: new Promise((resolve) => setTimeout(() => {
        h.emit('tools/result', { agent: { id: 'unrelated' }, name: 'Ignored' })
        h.emit('tools/result', { agent: { id: spec.label }, name: 'Read' })
        resolve({ stopReason: 'completed', output: [] })
      }, 0)),
    }))
    const value = await h.execute(batch)
    expect(value.subagents.map((row: any) => row.toolCalls)).toEqual([1, 1])
    expect(value.subagents[0].activity).toBe('Read')
    expect(value.subagents[0].startedAt).toBeTypeOf('number')
    expect(value.subagents[0].settledAt).toBeGreaterThanOrEqual(value.subagents[0].startedAt)
    expect(h.listeners.get('tools/result')?.size).toBe(0)
  })
})

describe('preset and mapping precedence', () => {
  it('prefers a registered preset over a same-named mapping label while keeping its model mapping', async () => {
    const h = setup(makeConfig({ modelMappingEnabled: volatile(true) as Config['modelMappingEnabled'],
      modelMapping: volatile([{ type: 'review', provider: 'p', model: 'mapped' }]) as Config['modelMapping'] }))
    h.services.agentPresets = { list: async () => [{ id: 'review' }] }
    await h.execute({ ...batch, subagent_type: 'review' })
    expect(h.subagents.startActivation.mock.calls[0][0].request).toMatchObject({ agentPreset: 'review', agentOptions: { provider: 'p', model: 'mapped' } })
  })
  it('preserves complete item text in final values and metadata', async () => {
    const h = setup()
    const item = '完整内容'.repeat(80)
    const args = { ...batch, items: [item, 'short'] }
    const value = await h.execute(args)
    expect(value.subagents[0].item).toBe(item)
    expect(h.tool().output.presentationMeta(args, value).subagents[0].item).toBe(item)
  })
})

it('rejects an enabled mapping with a missing model before starting children', async () => {
  const h = setup(makeConfig({ modelMappingEnabled: volatile(true) as Config['modelMappingEnabled'],
    modelMapping: volatile([{ type: 'coder', provider: '', model: '  ' }]) as Config['modelMapping'] }))
  await expect(h.execute(batch)).rejects.toThrow('missing its required model')
  expect(h.subagents.startActivation).not.toHaveBeenCalled()
})
