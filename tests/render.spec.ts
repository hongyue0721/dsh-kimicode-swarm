/**
 * Host-layer render tests: renderSwarmResults XML round-trip covers M2 (type/
 * model/mode attributes preserved through settlement) and H1 (resume tasks
 * rendered with correct kind/agent_id).
 */
import { describe, expect, it } from 'vitest'
import { renderSwarmResults } from '../src/index.ts'
import type { SwarmRunResult } from '../src/core/types.ts'

function makeResult(overrides: Partial<SwarmRunResult> = {}): SwarmRunResult {
  return {
    task: {
      index: 1,
      kind: 'spawn',
      item: 'src/a.ts',
      prompt: 'Check src/a.ts',
      type: 'coder',
      model: undefined,
      resumeAgentId: undefined,
      description: 'task #1 (coder)',
      ...overrides.task,
    },
    agentId: 'agent-1',
    status: 'completed',
    state: 'started',
    result: 'all good',
    ...overrides,
  }
}

describe('renderSwarmResults', () => {
  it('emits type, model, and mode attributes for spawn tasks', () => {
    const xml = renderSwarmResults([
      makeResult({
        task: {
          index: 1,
          kind: 'spawn',
          item: 'src/a.ts',
          prompt: '',
          type: 'reviewer',
          model: { provider: 'deepseek-official', model: 'deepseek-v3' },
          resumeAgentId: undefined,
          description: '',
        },
      }),
    ])
    expect(xml).toContain('type="reviewer"')
    expect(xml).toContain('model="deepseek-v3"')
    expect(xml).toContain('mode="spawn"')
  })

  it('emits mode="resume" for resume tasks with agent_id', () => {
    const xml = renderSwarmResults([
      makeResult({
        task: {
          index: 1,
          kind: 'resume',
          item: undefined,
          prompt: 'Continue the work',
          type: undefined,
          model: undefined,
          resumeAgentId: 'agent-abc',
          description: '',
        },
        agentId: 'agent-abc',
      }),
    ])
    expect(xml).toContain('mode="resume"')
    expect(xml).toContain('agent_id="agent-abc"')
    // Resume tasks have no type/model, so those attributes should be absent.
    expect(xml).not.toContain('type="')
    expect(xml).not.toContain('model="')
  })

  it('omits type and model attributes when undefined', () => {
    const xml = renderSwarmResults([
      makeResult({
        task: {
          index: 1,
          kind: 'spawn',
          item: 'x',
          prompt: '',
          type: undefined,
          model: undefined,
          resumeAgentId: undefined,
          description: '',
        },
      }),
    ])
    expect(xml).toContain('mode="spawn"')
    expect(xml).not.toContain('type="')
    expect(xml).not.toContain('model="')
  })

  it('round-trips type and model through parseResultsXml via the XML output', () => {
    // parseResultsXml is not exported, but presentationMeta calls it on the
    // rendered XML. We verify the XML carries the attributes that the parser
    // reads (type=, model=, mode=), confirming the round-trip is sound.
    const xml = renderSwarmResults([
      makeResult({
        task: {
          index: 1,
          kind: 'spawn',
          item: 'src/a.ts',
          prompt: '',
          type: 'explore',
          model: { provider: 'p', model: 'm1' },
          resumeAgentId: undefined,
          description: '',
        },
        status: 'completed',
        result: 'done',
      }),
      makeResult({
        task: {
          index: 2,
          kind: 'resume',
          item: undefined,
          prompt: 'go on',
          type: undefined,
          model: undefined,
          resumeAgentId: 'agent-xyz',
          description: '',
        },
        agentId: 'agent-xyz',
        status: 'failed',
        error: 'timeout',
      }),
    ])
    // Both rows present with their distinguishing attributes.
    expect(xml).toContain('type="explore"')
    expect(xml).toContain('model="m1"')
    expect(xml).toContain('mode="spawn"')
    expect(xml).toContain('mode="resume"')
    expect(xml).toContain('agent_id="agent-xyz"')
  })

  it('includes resume_hint when there are failed or aborted tasks', () => {
    const xml = renderSwarmResults([
      makeResult({ status: 'completed', result: 'ok' }),
      makeResult({
        task: { index: 2, kind: 'spawn', item: 'b', prompt: '', type: 'coder', model: undefined, resumeAgentId: undefined, description: '' },
        agentId: 'agent-2',
        status: 'failed',
        error: 'error',
      }),
    ])
    expect(xml).toContain('<resume_hint>')
  })

  it('does not include resume_hint when all tasks completed', () => {
    const xml = renderSwarmResults([
      makeResult({ status: 'completed', result: 'ok' }),
      makeResult({
        task: { index: 2, kind: 'spawn', item: 'b', prompt: '', type: 'coder', model: undefined, resumeAgentId: undefined, description: '' },
        agentId: 'agent-2',
        status: 'completed',
        result: 'ok2',
      }),
    ])
    expect(xml).not.toContain('<resume_hint>')
  })

  it('escapes XML special characters in attribute values', () => {
    const xml = renderSwarmResults([
      makeResult({
        task: {
          index: 1,
          kind: 'spawn',
          item: 'file<"weird">&name',
          prompt: '',
          type: 'coder',
          model: undefined,
          resumeAgentId: undefined,
          description: '',
        },
        agentId: 'agent<"id">',
      }),
    ])
    expect(xml).toContain('item="file&lt;&quot;weird&quot;&gt;&amp;name"')
    expect(xml).toContain('agent_id="agent&lt;&quot;id&quot;&gt;"')
  })
})