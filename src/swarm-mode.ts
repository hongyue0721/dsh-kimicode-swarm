/** User-owned, durable swarm mode. Plugin records never enter the model transcript. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { SwarmModeFrame } from './progress.ts'

export interface SwarmModeState {
  active: boolean
  trigger: 'manual' | 'task' | null
  everActive: boolean
}

export const MODE_RECORD = 'plugin:dsh-kimicode-swarm/mode'
const MODE_KEY = 'kimicodeSwarmMode'
export const initialMode = (): SwarmModeState => ({ active: false, trigger: null, everActive: false })

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-kimicode-swarm/mode': SwarmModeState
  }
}
/** Narrow rc.5 runtime seam; the supplied SDK omits the projection package. */
interface ModeProjectionRegistry {
  register(definition: {
    key: string
    stateVersion: number
    stateSchema: { parse(data: unknown): SwarmModeState }
    init(): SwarmModeState
    apply(state: SwarmModeState, event: SessionEvent): SwarmModeState
  }): () => void
  stateOf(session: Session, key: string): SwarmModeState | undefined
}

/** Validate restored data rather than inventing missing mode facts. */
export function parseMode(data: unknown): SwarmModeState {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid swarm mode record: expected an object.')
  const value = data as Record<string, unknown>
  if (typeof value.active !== 'boolean' || typeof value.everActive !== 'boolean' ||
      !['manual', 'task', null].includes(value.trigger as string | null) ||
      value.active !== (value.trigger !== null) || (value.active && !value.everActive)) {
    throw new Error('Invalid swarm mode record: active, trigger and everActive must describe a consistent state.')
  }
  return { active: value.active, trigger: value.trigger as SwarmModeState['trigger'], everActive: value.everActive }
}

export function foldMode(state: SwarmModeState, event: SessionEvent): SwarmModeState {
  const record = pluginRecordOf(event)
  if (record?.type === MODE_RECORD) return parseMode(record.data)
  if (event.type === 'turn/end' && state.trigger === 'task') {
    return { active: false, trigger: null, everActive: true }
  }
  return state
}

export const ACTIVE_SWARM_CONTEXT =
  'Swarm mode is active by user request. First do a small amount of exploration. ' +
  'If the task does not benefit from splitting, tell the user and stop. Otherwise call swarm_batch once ' +
  'with independent, non-overlapping subtasks. Do not reduce the number merely to save dispatches; up to 128 ' +
  'items are supported and work beyond concurrency capacity queues automatically. Give each child enough context. ' +
  'Subagents have approval policy never: operations beyond delegated permissions are rejected, not held for approval. ' +
  'Leave work requiring additional permission to the parent agent. Summarize the results when the batch settles.'

const MODE_WARNING = 'Swarm mode may consume several times the tokens of a normal task. ' +
  'Subagents cannot request extra approval; operations beyond their delegated permissions are rejected and must be handled by the parent agent.'

export class SwarmModeController {
  private readonly registry: ModeProjectionRegistry

  constructor(ctx: Context, private readonly publish: (frame: SwarmModeFrame) => void) {
    const registry = ctx.get('sessionProjections') as ModeProjectionRegistry | undefined
    if (registry === undefined) throw new Error('Swarm mode requires the host sessionProjections service.')
    this.registry = registry
    // rc.5 consumes only parse() on this seam. Reuse the strict record validator
    // without adding a non-SDK runtime dependency on Zod.
    const stateSchema = { parse: parseMode }
    registry.register({ key: MODE_KEY, stateVersion: 1, stateSchema, init: initialMode, apply: foldMode })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' || pluginRecordOf(event)?.type === MODE_RECORD) this.announce(session)
    })
    ctx.on('session/created', (session) => this.announce(session))
    ctx.systemPrompt.context({
      name: 'plugin:dsh-kimicode-swarm/mode', order: 130, required: true,
      text: ({ agent }) => agent === undefined ? '' : this.context(agent.session),
    })
  }

  get(session: Session): SwarmModeState {
    // A fork child inherits parent records but never inherits user authorization.
    if (session.header.origin === 'subagent') return initialMode()
    const state = this.registry.stateOf(session, MODE_KEY)
    if (state === undefined) throw new Error(`Swarm mode projection is missing for session ${session.id}.`)
    return state
  }

  set(session: Session, trigger: SwarmModeState['trigger']): boolean {
    const previous = this.get(session)
    if (previous.active === (trigger !== null) && previous.trigger === trigger) return false
    appendPluginRecord(session, MODE_RECORD, {
      active: trigger !== null, trigger, everActive: previous.everActive || trigger !== null,
    })
    this.announce(session)
    return true
  }

  private announce(session: Session): void {
    const { active, trigger } = this.get(session)
    this.publish({ sessionId: session.id, active, trigger })
  }

  private context(session: Session): string {
    const state = this.get(session)
    if (state.active) return ACTIVE_SWARM_CONTEXT
    return state.everActive ? 'Swarm mode has ended. Do not call swarm_batch again unless the user re-enables it.' : ''
  }

  command(): CommandDefinition {
    return {
      name: 'swarm', description: 'Toggle Swarm mode, select on/off, or dispatch a one-turn task',
      input: { hint: '[on|off|task]' },
      handler: ({ agent, rawInput }) => {
        if (agent.session.header.origin === 'subagent') {
          return { kind: 'error', text: 'Swarm mode cannot be enabled inside a delegated subagent session.' }
        }
        const input = rawInput.trim()
        const state = this.get(agent.session)
        if (input === '' || input === 'on' || input === 'off') {
          const active = input === '' ? !state.active : input === 'on'
          if (state.active === active) return { kind: 'success', text: `Swarm mode is already ${active ? 'on' : 'off'}.` }
          this.set(agent.session, active ? 'manual' : null)
          return { kind: 'success', text: active ? `Swarm mode on. ${MODE_WARNING}` : 'Swarm mode off.' }
        }
        this.set(agent.session, 'task')
        agent.steer(createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } }))
        return { kind: 'success', text: `Swarm mode on for this task; it ends at turn end. ${MODE_WARNING}` }
      },
    }
  }
}
