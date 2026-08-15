/**
 * dsh-swarm core types: tool-argument schema, normalized task model, and the
 * attempt/result contracts the scheduler runs on.
 *
 * Framework-free on purpose: the runtime faces are declared structurally so
 * tests drive the scheduler with plain fakes (same pattern as the task-board
 * ExecutionService). The host half adapts these to `ctx.subagents`.
 */
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Placeholder inside `prompt_template`; replaced with each item's value. */
export const PROMPT_TEMPLATE_PLACEHOLDER = '{{item}}'

/** Upper bound on subagents per swarm call (mirrors Kimi's MAX_AGENT_SWARM_SUBAGENTS). */
export const MAX_SWARM_SUBAGENTS = 128

/** One item with explicit per-item model / type overrides. */
export interface SwarmItemInput {
  item: string
  /** Explicit model for THIS item; highest priority in model resolution. */
  model?: string
  /** Task type used for the settings mapping-table lookup. */
  type?: string
}

/** `items` accepts plain strings (model resolved by policy) or rich items. */
export type SwarmItemsInput = Array<string | SwarmItemInput>

/** One resolved subagent task after argument normalization. */
export interface SwarmTask {
  /** 1-based index (matches the rendered `#N` description). */
  index: number
  kind: 'spawn' | 'resume'
  /** Item value filled into the template; absent for resume entries. */
  item: string | undefined
  /** Final per-subagent prompt (template filled). */
  prompt: string
  /** Subagent type (defaults to `coder`); feeds mapping-table lookups. */
  type: string | undefined
  /** Explicit model (provider/model pair) or undefined to inherit the caller. */
  model: { provider?: string; model: string } | undefined
  /** Resume target agent id; defined only for kind === 'resume'. */
  resumeAgentId: string | undefined
  /** Human-readable short description for logs and the UI. */
  description: string
}

/** Outcome of one spawn attempt, as observed by the scheduler. */
export interface SwarmAttemptResult {
  /** Child agent id, when the attempt published one (kept for same-agent retry). */
  agentId: string | undefined
  status: 'completed' | 'failed' | 'aborted'
  /** Whether the child had started before the terminal state; absent = never started. */
  state?: 'started' | 'not_started'
  /** Final assistant output for a completed run. */
  result?: string
  error?: string
  /** True when the attempt hit a provider rate limit (triggers backoff). */
  rateLimited?: boolean
}

/** One settled slot, paired with its task. */
export interface SwarmRunResult {
  task: SwarmTask
  agentId: string | undefined
  status: 'completed' | 'failed' | 'aborted'
  state?: 'started' | 'not_started'
  result?: string
  error?: string
}

/** Starts one subagent and resolves with its terminal state. Never throws. */
export type SpawnFn = (task: SwarmTask, signal: AbortSignal) => Promise<SwarmAttemptResult>

/** Tool-argument schema advertised to the model (dsh-tools parameter spec). */
export const swarmParameters = {
  description: {
    type: 'string',
    required: true,
    description: 'Short description for the whole swarm.',
  },
  subagent_type: {
    type: 'string',
    description:
      'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type.',
  },
  model: {
    type: 'string',
    description:
      'Model for every new subagent spawned from items (overrides the settings mapping table). Resumed subagents keep their bound model. Omit to let the agent decide per task.',
  },
  prompt_template: {
    type: 'string',
    description: `Prompt template for each subagent. The ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder is replaced with each item value.`,
  },
  items: {
    type: 'array',
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: {
            item: {
              type: 'string',
              required: true,
              description: 'Value filled into the prompt template.',
            },
            model: {
              type: 'string',
              description: 'Explicit model for this item only (highest priority).',
            },
            type: {
              type: 'string',
              description: 'Task type; looked up in the settings model-mapping table.',
            },
          },
          additionalProperties: false,
        },
      ],
    },
    description:
      'Values used to fill the prompt template; each entry launches one subagent (1..128). A plain string uses the policy-resolved model; an object may carry per-item model/type.',
  },
  resume_agent_ids: {
    type: 'json',
    description:
      'Map of existing subagent agent_id to the prompt used to resume that subagent (Record<string,string>). Resumed subagents are launched before new item-based subagents.',
  },
} satisfies ParameterSchemaSpec

/** Normalized tool input (mirrors the schema; json fields re-validated at runtime). */
export interface SwarmToolArgs {
  description: string
  subagent_type?: string
  model?: string
  prompt_template?: string
  items?: SwarmItemsInput
  resume_agent_ids?: Record<string, string>
}

/** Error thrown by argument normalization; message is model-facing. */
export class SwarmArgsError extends Error {}
