/**
 * Argument normalization for `swarm_batch`: validates the tool input, expands
 * items into tasks, resolves each task's model through the three-level policy
 * (explicit > mapping table > inherit), and enforces the duplicate-prompt rule.
 */
import {
  MAX_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  SwarmArgsError,
  type SwarmItemInput,
  type SwarmItemsInput,
  type SwarmTask,
  type SwarmToolArgs,
} from './types.ts'

/** Default subagent type when the caller omits `subagent_type`. */
export const DEFAULT_SUBAGENT_TYPE = 'coder'

/** A resolved model selection for one task. */
export interface ResolvedModel {
  provider?: string
  model: string
}

/**
 * Model resolution policy for one task. Implemented by the host half (reads
 * the settings mapping table); tests inject fakes.
 */
export interface ModelResolver {
  /**
   * Resolve the model for one task. `explicit` is the per-item / batch model
   * the model asked for (highest priority); `type` is the subagent type.
   * Return undefined to inherit the caller's model.
   */
  resolve(explicit: string | undefined, type: string | undefined): ResolvedModel | undefined
}

/** Normalization result. */
export interface NormalizedSwarm {
  description: string
  tasks: SwarmTask[]
}

/**
 * Normalize tool arguments into an ordered task list. Resume entries launch
 * before new item-based spawns; fully duplicate prompts are rejected.
 * @throws SwarmArgsError with a model-facing message.
 */
export function normalizeSwarmArgs(
  args: SwarmToolArgs,
  modelResolver: ModelResolver,
): NormalizedSwarm {
  const description = args.description.trim()
  if (description.length === 0) throw new SwarmArgsError('description is required.')

  const batchModel = optionalString(args.model)
  const subagentType = optionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE
  const promptTemplate = optionalString(args.prompt_template)
  const items = normalizeItems(args.items)
  const resumes = normalizeResumeEntries(args.resume_agent_ids)

  const itemCount = items.length
  const resumeCount = resumes.length
  const total = itemCount + resumeCount
  if (resumeCount === 0 && itemCount < 2) {
    throw new SwarmArgsError(
      'swarm_batch requires at least 2 items unless resume_agent_ids is provided.',
    )
  }
  if (total > MAX_SWARM_SUBAGENTS) {
    throw new SwarmArgsError(`swarm_batch supports at most ${MAX_SWARM_SUBAGENTS} subagents.`)
  }
  if (itemCount > 0 && promptTemplate === undefined) {
    throw new SwarmArgsError('prompt_template is required when items are provided.')
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new SwarmArgsError(
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    )
  }

  const tasks: SwarmTask[] = []
  const seenPrompts = new Map<string, number>()

  // Resume entries launch first, keeping their original type/model.
  for (const [agentId, prompt] of resumes) {
    assertDistinctPrompt(seenPrompts, prompt, -1)
    tasks.push({
      index: tasks.length + 1,
      kind: 'resume',
      item: undefined,
      prompt,
      type: undefined,
      model: undefined,
      resumeAgentId: agentId,
      description: `${description} #${tasks.length + 1} (resume)`,
    })
  }

  // Item-based spawns: template fill + model resolution per item.
  const template = promptTemplate ?? ''
  items.forEach((entry, position) => {
    const prompt = template.split(PROMPT_TEMPLATE_PLACEHOLDER).join(entry.item)
    assertDistinctPrompt(seenPrompts, prompt, position)
    const type = entry.type ?? subagentType
    tasks.push({
      index: tasks.length + 1,
      kind: 'spawn',
      item: entry.item,
      prompt,
      type,
      model: modelResolver.resolve(entry.model ?? batchModel, type),
      resumeAgentId: undefined,
      description: `${description} #${tasks.length + 1} (${type})`,
    })
  })

  return { description, tasks }
}

/** One normalized item entry. */
interface NormalizedItem {
  item: string
  model?: string
  type?: string
}

function normalizeItems(input: SwarmItemsInput | undefined): NormalizedItem[] {
  if (input === undefined) return []
  const out: NormalizedItem[] = []
  for (const raw of input) {
    if (typeof raw === 'string') {
      const item = raw.trim()
      if (item.length === 0) throw new SwarmArgsError('items must not contain empty strings.')
      out.push({ item })
    } else {
      const item = raw.item.trim()
      if (item.length === 0) throw new SwarmArgsError('items must not contain empty items.')
      out.push({
        item,
        model: optionalString(raw.model),
        type: optionalString(raw.type),
      })
    }
  }
  return out
}

function normalizeResumeEntries(input: unknown): Array<[string, string]> {
  if (input === undefined) return []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SwarmArgsError('resume_agent_ids must be a map of agent_id to prompt.')
  }
  const out: Array<[string, string]> = []
  for (const [agentId, prompt] of Object.entries(input)) {
    const trimmedAgent = agentId.trim()
    const trimmedPrompt = String(prompt).trim()
    if (trimmedAgent.length === 0 || trimmedPrompt.length === 0) {
      throw new SwarmArgsError('resume_agent_ids entries must have non-empty agent_id and prompt.')
    }
    out.push([trimmedAgent, trimmedPrompt])
  }
  return out
}

/** Reject two tasks expanding to the exact same prompt (mirrors Kimi's dedup). */
function assertDistinctPrompt(
  seen: Map<string, number>,
  prompt: string,
  position: number,
): void {
  const previous = seen.get(prompt)
  if (previous !== undefined) {
    throw new SwarmArgsError(
      `Duplicate subagent prompts from items ${previous + 1} and ${position + 1}. ` +
        'swarm_batch requires distinct subagents.',
    )
  }
  seen.set(prompt, position)
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Convenience: a resolver that only honors the explicit model (no mapping table). */
export function explicitOnlyResolver(): ModelResolver {
  return {
    resolve(explicit) {
      if (explicit === undefined) return undefined
      return { model: explicit }
    },
  }
}
