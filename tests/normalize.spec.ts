/**
 * Argument normalization tests: template filling, resume-first ordering,
 * duplicate-prompt rejection, bounds, and the three-level model resolution.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBAGENT_TYPE,
  explicitOnlyResolver,
  normalizeSwarmArgs,
  type ModelResolver,
} from '../src/core/normalize.ts'
import { MAX_SWARM_SUBAGENTS, SwarmArgsError, type SwarmToolArgs } from '../src/core/types.ts'

const mappingResolver: ModelResolver = {
  resolve(explicit, type) {
    if (explicit !== undefined) return { model: explicit }
    if (type === 'explore') return { provider: 'deepseek-official', model: 'deepseek-v3' }
    if (type === 'plan') return { provider: 'deepseek-official', model: 'deepseek-r1' }
    return undefined
  },
}

const baseArgs: SwarmToolArgs = {
  description: 'Audit the repo',
  prompt_template: 'Check {{item}}',
  items: ['src/a.ts', 'src/b.ts'],
}

describe('normalizeSwarmArgs', () => {
  it('fills the template and resolves models via the mapping table', () => {
    const { tasks } = normalizeSwarmArgs(baseArgs, mappingResolver)
    expect(tasks).toHaveLength(2)
    expect(tasks[0].prompt).toBe('Check src/a.ts')
    expect(tasks[0].type).toBe(DEFAULT_SUBAGENT_TYPE)
    expect(tasks[0].model).toBeUndefined()
    expect(tasks[1].prompt).toBe('Check src/b.ts')
  })

  it('per-item explicit model wins; batch model overrides the mapping table', () => {
    const { tasks } = normalizeSwarmArgs(
      {
        ...baseArgs,
        model: 'batch-model',
        items: [
          { item: 'a', model: 'item-model' },
          { item: 'b', type: 'explore' },
          'c',
        ],
      },
      mappingResolver,
    )
    // item-level explicit beats everything.
    expect(tasks[0].model).toEqual({ model: 'item-model' })
    // batch-level explicit beats the mapping table (explicit > mapping).
    expect(tasks[1].model).toEqual({ model: 'batch-model' })
    expect(tasks[2].model).toEqual({ model: 'batch-model' })
  })

  it('mapping table applies when no explicit model is given', () => {
    const { tasks } = normalizeSwarmArgs(
      { ...baseArgs, items: ['a', { item: 'b', type: 'explore' }] },
      mappingResolver,
    )
    expect(tasks[0].model).toBeUndefined() // inherit the caller
    expect(tasks[1].model).toEqual({ provider: 'deepseek-official', model: 'deepseek-v3' })
  })

  it('keeps subagent type per item and falls back to subagent_type', () => {
    const { tasks } = normalizeSwarmArgs(
      {
        ...baseArgs,
        subagent_type: 'plan',
        items: [{ item: 'a' }, { item: 'b', type: 'explore' }],
      },
      mappingResolver,
    )
    expect(tasks[0].type).toBe('plan')
    expect(tasks[0].model).toEqual({ provider: 'deepseek-official', model: 'deepseek-r1' })
    expect(tasks[1].type).toBe('explore')
  })

  it('launches resume entries before new item-based spawns', () => {
    const { tasks } = normalizeSwarmArgs(
      {
        ...baseArgs,
        resume_agent_ids: { 'agent-9': 'Continue the work' },
      },
      explicitOnlyResolver(),
    )
    expect(tasks).toHaveLength(3)
    expect(tasks[0].kind).toBe('resume')
    expect(tasks[0].resumeAgentId).toBe('agent-9')
    expect(tasks[1].kind).toBe('spawn')
    expect(tasks[2].kind).toBe('spawn')
  })

  it('rejects duplicate expanded prompts', () => {
    expect(() =>
      normalizeSwarmArgs(
        { ...baseArgs, items: ['x', 'x'] },
        explicitOnlyResolver(),
      ),
    ).toThrow(SwarmArgsError)
  })

  it('rejects fewer than 2 items without resume entries', () => {
    expect(() =>
      normalizeSwarmArgs(
        { ...baseArgs, items: ['only-one'] },
        explicitOnlyResolver(),
      ),
    ).toThrow(SwarmArgsError)
  })

  it('accepts a single item when resume entries are present', () => {
    const { tasks } = normalizeSwarmArgs(
      { ...baseArgs, items: ['only-one'], resume_agent_ids: { a: 'go' } },
      explicitOnlyResolver(),
    )
    expect(tasks).toHaveLength(2)
  })

  it('rejects more than the subagent cap', () => {
    const many = Array.from({ length: MAX_SWARM_SUBAGENTS + 1 }, (_, i) => `f${i}.ts`)
    expect(() =>
      normalizeSwarmArgs({ ...baseArgs, items: many }, explicitOnlyResolver()),
    ).toThrow(SwarmArgsError)
  })

  it('requires prompt_template with items', () => {
    expect(() =>
      normalizeSwarmArgs({ description: 'x', items: ['a', 'b'] }, explicitOnlyResolver()),
    ).toThrow(SwarmArgsError)
  })

  it('requires the placeholder in prompt_template', () => {
    expect(() =>
      normalizeSwarmArgs(
        { description: 'x', prompt_template: 'no placeholder', items: ['a', 'b'] },
        explicitOnlyResolver(),
      ),
    ).toThrow(SwarmArgsError)
  })
})
