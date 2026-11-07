/**
 * Host loader entry for the dsh-swarm plugin — runs in the DSH host process.
 *
 * Registers the `swarm_batch` tool (batch-parallel subagent dispatch with the
 * Kimi-style adaptive scheduler), a live Config schema for the model-mapping
 * table, and a system-prompt announcement so every agent knows the tool and
 * how to use it.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentActivation, SubagentResult, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx.commands Context merge.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { normalizeSwarmArgs, type ModelResolver, type PresetResolver } from './core/normalize.ts'
import { SwarmScheduler } from './core/scheduler.ts'
import {
  PROMPT_TEMPLATE_PLACEHOLDER,
  SwarmArgsError,
  swarmParameters,
  type SpawnFn,
  type SwarmAttemptResult,
  type SwarmRunResult,
  type SwarmTask,
  type SwarmToolArgs,
} from './core/types.ts'
import {
  createProgressBroadcaster,
  SWARM_PROGRESS_ROUTE,
  type ProgressBroadcaster,
} from './progress.ts'

import { SwarmModeController } from './swarm-mode.ts'
import { DEFAULT_MAX_CONCURRENCY, DEFAULT_REQUIRE_SWARM_MODE, DEFAULT_SWARM_TIMEOUT_MS } from './defaults.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Subagent provider name (registered by @deepseek-ai/dsh-subagent-spawn-in-process). */
const SUBAGENT_PROVIDER = 'spawn'
export const FORK_PROVIDER = 'fork'

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SWARM_GUIDANCE =
  'This machine has the dsh-swarm plugin installed (batch-parallel sub-agent dispatch): the `swarm_batch` tool can ' +
  'dispatch up to 128 independent subtasks in parallel in one call (prompt_template + items batch-generate; the template ' +
  'placeholder follows the tool parameter description; resume_agent_ids also supports resuming unfinished work). ' +
  'Good for batch code review, independent multi-file refactors, parallel research, and batch generation. ' +
  'Three-tier model assignment policy: item-level/whole-batch explicit model > settings mapping table (matched by type) > ' +
  'inherit the caller\'s model (default, freely assigned by the agent). ' +
  'Scheduling ramps up automatically and backs off under rate limits; the user can cancel at any time, and completed ' +
  'results are kept. ' +
  'Not suited to strongly sequential, dependent tasks or deep single-file edits (splitting those up only adds merge cost). ' +
  'By default only the user can enable Swarm mode with /swarm on; do not call swarm_batch before that. ' +
  'Explicit registered preset ids select a spawn child composition; otherwise omit the type to inherit the parent. ' +
  'Fork children inherit completed conversation history and cost more tokens; model and preset overrides are not available for fork. ' +
  'When the user mentions "swarm / batch-parallel / parallel subtasks", they mean this plugin — cooperate accordingly.'

/** Default per-subagent timeout, the same two hours Kimi Code uses for swarm members. */

/** Message a rate-limit retry sends to the child it continues. */
const RETRY_PROMPT = 'continue'

/** Host failure class of a provider rate limit (dsh-llm's shared taxonomy). */
const RATE_LIMIT_CODE = 'RATE_LIMIT'

/** Host error when its active-child limit is full (dsh-subagent). */
const ACTIVATION_LIMIT_CODE = 'ACTIVATION_LIMIT_REACHED'

/** One row of the type -> model mapping table. */
export interface SwarmModelMappingRow {
  type: string
  provider: string
  model: string
}

/**
 * Plugin config as the loader hands it to `apply`. Only volatile fields appear
 * in the settings form and change without a remount, so the mapping table is
 * volatile and read per dispatch; the two mount-time switches remount the
 * plugin when the profile entry changes.
 */
export interface Config {
  /** Require explicit user enablement before any dispatch. */
  requireSwarmMode: Volatile<boolean>
  /** Per-subagent timeout in ms; 0 disables it. */
  timeoutMs: Volatile<number>
  /** Concurrency cap for one batch; 0 leaves only the host's active-child limit. */
  maxConcurrency: Volatile<number>
  /** Master switch for the plugin (tool + command + announcement). */
  enabled: boolean
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent: boolean
  /** When true, dispatch resolves models through the mapping table. */
  modelMappingEnabled: Volatile<boolean>
  /** Type -> model mapping table rows. */
  modelMapping: Volatile<SwarmModelMappingRow[]>
}

// The annotation keeps the emitted declaration free of schemastery's transitive types.
export const Config: z<any, Config> = z.object({
  enabled: z.boolean().default(true),
  requireSwarmMode: z.boolean().default(DEFAULT_REQUIRE_SWARM_MODE).volatile(),
  announceToAgent: z.boolean().default(true),
  timeoutMs: z.number().min(0).step(1).default(DEFAULT_SWARM_TIMEOUT_MS).volatile(),
  maxConcurrency: z.number().min(0).step(1).default(DEFAULT_MAX_CONCURRENCY).volatile(),
  modelMappingEnabled: z.boolean().default(false).volatile(),
  modelMapping: z
    .array(
      z.object({
        type: z.string(),
        provider: z.string().default(''),
        model: z.string(),
      }),
    )
    .default([])
    .volatile(),
})

/** Stable machine code of a thrown host error, when it carries one. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Attempt fields describing a thrown start or delivery error. */
function thrownOutcome(error: unknown): Pick<SwarmAttemptResult, 'error' | 'rateLimited' | 'capacityLimited'> {
  return {
    error: error instanceof Error ? error.message : String(error),
    rateLimited: errorCode(error) === RATE_LIMIT_CODE,
    capacityLimited: errorCode(error) === ACTIVATION_LIMIT_CODE,
  }
}

/** Subagent text output, joined across blocks. */
function textOf(result: SubagentResult): string {
  return result.output
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

/** Extract text from a raw ContentBlock[] (the resume path's lastAssistantMessage). */
function textOfBlocks(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

/** One settled subagent in the tool's canonical output value. */
export interface SwarmResultRow {
  startedAt?: number
  settledAt?: number
  toolCalls?: number
  activity?: string
  retries?: number
  index: number
  kind: SwarmTask['kind']
  status: SwarmRunResult['status']
  item?: string
  type?: string
  model?: string
  agentId?: string
  state?: NonNullable<SwarmRunResult['state']>
  result?: string
  error?: string
}

/** Canonical output schema; meta and the model text both project from this value. */
const swarmOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subagents: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          kind: { type: 'string', required: true, enum: ['spawn', 'fork', 'resume'] },
          status: { type: 'string', required: true, enum: ['completed', 'failed', 'aborted'] },
          item: { type: 'string' },
          type: { type: 'string' },
          model: { type: 'string' },
          agentId: { type: 'string' },
          state: { type: 'string', enum: ['started', 'not_started'] },
          result: { type: 'string' },
          error: { type: 'string' },
          startedAt: { type: 'number' },
          settledAt: { type: 'number' },
          toolCalls: { type: 'integer' },
          activity: { type: 'string' },
          retries: { type: 'integer' },
        },
      },
    },
  },
} as const

/** Project a scheduler result onto the output row, omitting absent fields. */
function toResultRow(run: SwarmRunResult): SwarmResultRow {
  return {
    index: run.task.index,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.settledAt === undefined ? {} : { settledAt: run.settledAt }),
    ...(run.toolCalls === undefined ? {} : { toolCalls: run.toolCalls }),
    ...(run.activity === undefined ? {} : { activity: run.activity }),
    ...(run.retries === undefined ? {} : { retries: run.retries }),
    kind: run.task.kind,
    status: run.status,
    ...(run.task.item === undefined ? {} : { item: run.task.item }),
    ...(run.task.type === undefined ? {} : { type: run.task.type }),
    ...(run.task.model === undefined ? {} : { model: run.task.model.model }),
    ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
    ...(run.state === undefined ? {} : { state: run.state }),
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.error === undefined ? {} : { error: run.error }),
  }
}

/** Keep subagent output from closing or forging the result envelope. */
function neutralizeEnvelopeTags(body: string): string {
  return body.replace(/<(\/?)(subagent|agent_swarm_result)\b/g, '&lt;$1$2')
}

function renderRows(rows: readonly SwarmResultRow[]): string {
  const completed = rows.filter((r) => r.status === 'completed').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const aborted = rows.filter((r) => r.status === 'aborted').length
  const summary = [
    completed > 0 ? `completed: ${completed}` : '',
    failed > 0 ? `failed: ${failed}` : '',
    aborted > 0 ? `aborted: ${aborted}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const lines = ['<agent_swarm_result>', `<summary>${summary}</summary>`]
  const resumable = rows.some((r) => r.status !== 'completed' && r.agentId !== undefined)
  const restartable = rows.some((r) => r.status !== 'completed' && r.agentId === undefined)
  if (resumable) {
    lines.push(
      '<resume_hint>Call swarm_batch with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    )
  }
  if (restartable) {
    lines.push(
      '<restart_hint>Subagents without an agent_id never started; dispatch their items again.</restart_hint>',
    )
  }
  for (const row of rows) {
    const agentId = row.agentId === undefined ? '' : ` agent_id="${escapeXml(row.agentId)}"`
    const item = row.item === undefined ? '' : ` item="${escapeXml(row.item)}"`
    const type = row.type === undefined ? '' : ` type="${escapeXml(row.type)}"`
    const model = row.model === undefined ? '' : ` model="${escapeXml(row.model)}"`
    const mode = ` mode="${row.kind}"`
    const state = row.state === undefined ? '' : ` state="${row.state}"`
    const body = row.status === 'completed' ? (row.result ?? '') : (row.error ?? 'unknown error')
    lines.push(
      `<subagent${agentId}${item}${type}${model}${mode}${state} outcome="${row.status}">${neutralizeEnvelopeTags(body)}</subagent>`,
    )
  }
  lines.push('</agent_swarm_result>')
  return lines.join('\n')
}

/** Render settled runs in the Kimi-style XML form the model can parse. */
export function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  return renderRows(results.map(toResultRow))
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Serve running-call progress frames to subscribed browser halves over SSE. */
export function progressRoute(broadcaster: ProgressBroadcaster): WebRoute {
  return {
    kind: 'exact',
    path: SWARM_PROGRESS_ROUTE,
    handler: (req, res) => {
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('origin host does not match request host')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' })
        res.end('method not allowed')
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      const detach = broadcaster.subscribe(res)
      // Request teardown detaches the stream; write failures self-prune.
      req.on('close', detach)
    },
  }
}

/** Origin checks constrain browser reads; they are not authentication. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}

/** Resolve the asynchronous host roster before any children can be scheduled. */
async function presetResolver(ctx: Context, config: Config): Promise<PresetResolver> {
  const registry = ctx.get('agentPresets')
  const presets = registry === undefined ? [] : await registry.list()
  const mappingTypes = config.modelMapping.get().map((row) => row.type)
  return {
    resolve(type) {
      const preset = presets.find((entry) => entry.id === type)
      if (preset !== undefined) {
        if (preset.broken !== undefined) throw new SwarmArgsError(`Agent preset ${type} is unavailable: ${preset.broken}`)
        return preset.id
      }
      if (mappingTypes.includes(type)) return undefined
      throw new SwarmArgsError(`Unknown subagent type ${JSON.stringify(type)}. Available preset ids: ${presets.filter((entry) => entry.broken === undefined).map((entry) => entry.id).join(', ') || '(none)'}. Mapping types: ${mappingTypes.join(', ') || '(none)'}.`)
    },
  }
}

/**
 * Apply the host half: announcement + tool/command/route registration.
 * @param ctx - the plugin context (systemPrompt/tools/subagents/commands/webServer injected).
 * @param config - loader-resolved plugin config.
 */
export const inject = ['systemPrompt', 'tools', 'subagents', 'commands', 'webServer', 'sessionProjections']
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return

  // Live progress transport. Progress is display-only, so it never enters the
  // session log; the SSE route replays running snapshots to browser halves.
  const broadcaster = createProgressBroadcaster()
  ctx.effect(() => () => broadcaster.close(), 'dsh-swarm: progress broadcaster')

  const mode = new SwarmModeController(ctx, (frame) => broadcaster.mode(frame))

  if (config.announceToAgent) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'plugin:dsh-swarm', order: SECTION_ORDER, text: SWARM_GUIDANCE }),
      'dsh-swarm: announcement',
    )
  }
  ctx.effect(() => ctx.tools.register(swarmTool(ctx, config, broadcaster, mode)), 'dsh-swarm: tool')
  ctx.effect(() => ctx.webServer.register(progressRoute(broadcaster)), 'dsh-swarm: progress route')
  ctx.effect(() => ctx.commands.register(mode.command()), 'dsh-swarm: command')
  await mode.ready
}

/** Build the `swarm_batch` tool definition against the live settings source. */
function swarmTool(
  ctx: Context,
  config: Config,
  broadcaster: ProgressBroadcaster,
  mode: SwarmModeController,
) {
  const modelResolver: ModelResolver = {
    resolve(explicit, type) {
      if (explicit !== undefined && explicit.length > 0) return { model: explicit }
      if (!config.modelMappingEnabled.get()) return undefined
      const entry = config.modelMapping.get().find((m) => m.type === type)
      if (entry === undefined) return undefined
      if (entry.model.trim() === '') throw new SwarmArgsError(`Model mapping for type ${JSON.stringify(type)} is missing its required model.`)
      return {
        provider: entry.provider.length > 0 ? entry.provider : undefined,
        model: entry.model,
      }
    },
  }

  return defineTool({
    name: 'swarm_batch',
    description:
      'Dispatch a batch of independent subagent tasks in parallel. ' +
      `Provide prompt_template containing ${PROMPT_TEMPLATE_PLACEHOLDER} and 2..128 items; ` +
      'each item launches one subagent. Only use after the user enables /swarm on when requireSwarmMode is enabled. ' +
      'Prefer calling this tool alone; it executes exclusively against sibling tool calls. fork inherits completed parent history at higher token cost. Results come back as an <agent_swarm_result> summary; ' +
      'failed or aborted tasks can be resumed with resume_agent_ids.',
    parameters: swarmParameters,
    isConcurrencySafe: () => false,
    output: {
      schema: swarmOutputSchema,
      render: (_args, value) => [{ type: 'text', text: renderRows(value.subagents as SwarmResultRow[]) }],
      presentationMeta: (args, value) => ({
        description: args.description,
        subagents: (value.subagents as SwarmResultRow[]).map((row) => ({
          ...row,
          index: row.index,
          item: row.item ?? null,
          type: row.type ?? null,
          model: row.model ?? null,
          status: row.status,
          state: row.state ?? null,
          agentId: row.agentId ?? null,
          error: row.error ?? null,
          result: row.result ?? null,
        })),
      }),
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) {
        throw new Error('swarm_batch requires a caller agent context.')
      }
      if (config.requireSwarmMode.get() && !mode.get(exec.agent.session).active) {
        throw new SwarmArgsError('Swarm mode is off. Only the user can enable it; ask the user to run /swarm on.')
      }
      let normalized
      try {
        normalized = normalizeSwarmArgs(args as unknown as SwarmToolArgs, modelResolver,
          args.fork === true ? undefined : await presetResolver(ctx, config))
        if (normalized.tasks.some((task) => task.kind === 'fork') && ctx.subagents.getProvider(FORK_PROVIDER) === undefined) {
          throw new SwarmArgsError('fork provider is unavailable; enable the host fork provider before requesting fork.')
        }
      } catch (error) {
        if (error instanceof SwarmArgsError) throw error
        throw new SwarmArgsError(`invalid swarm_batch arguments: ${String(error)}`)
      }

      const parent = exec.agent

      // A child's model failure ends its run with a bare stopReason, so the
      // failure class is observed here, on the host's request-error hook.
      const failures = new Map<string, { code: string; message: string }>()
      const stopRecordingFailures = ctx.on('agent/request-error', (payload, next) => {
        failures.set(payload.agent.id, { code: payload.failure.code, message: payload.failure.message })
        return next()
      })
      /** Attempt fields of a child that ended without completing. */
      const stoppedOutcome = (
        childId: string,
        stopReason: string,
      ): Pick<SwarmAttemptResult, 'error' | 'rateLimited'> => {
        const failure = stopReason === 'error' ? failures.get(childId) : undefined
        return {
          error: `subagent stopped: ${stopReason}${failure === undefined ? '' : ` (${failure.message})`}`,
          rateLimited: failure?.code === RATE_LIMIT_CODE,
        }
      }

      const interruptedError = 'The user manually interrupted this swarm before this subagent finished.'

      /**
       * Resume path: deliver a message to an existing child and await its
       * settlement via the scoped `subagent/end` event. `sendMessage` resolves
       * the moment the message is accepted into the child's inbox and the signal
       * owns only that window, so the turn is awaited through the lifecycle end
       * edge and cancelled through an explicit interrupt.
       */
      const resume = async (childId: string, prompt: string, signal: AbortSignal, onReady: (id: string) => void): Promise<SwarmAttemptResult> => {
        const interrupted = (): SwarmAttemptResult => {
          ctx.subagents.interrupt(childId as SessionId, { kind: 'ancestor', agent: parent })
          return { agentId: childId, status: 'aborted', state: 'started', error: interruptedError }
        }
        // Register the end listener BEFORE delivery to avoid losing the edge in
        // the window between acceptance and turn completion.
        let resolveEnd: (info: SubagentRunEndInfo) => void = () => {}
        const ended = new Promise<SubagentRunEndInfo>((resolve) => {
          resolveEnd = resolve
        })
        const off = ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
          if (info.id === childId) resolveEnd(info)
        })
        let onAbort: (() => void) | undefined
        failures.delete(childId)
        try {
          await ctx.subagents.sendMessage(parent, childId as SessionId, [{ type: 'text', text: prompt }], { signal })
          onReady(childId)
          if (signal.aborted) return interrupted()
          const aborted = new Promise<undefined>((resolve) => {
            onAbort = () => resolve(undefined)
            signal.addEventListener('abort', onAbort, { once: true })
          })
          const info = await Promise.race([ended, aborted])
          if (info === undefined) return interrupted()
          const completed = info.stopReason === 'completed'
          return {
            agentId: childId,
            status: completed ? 'completed' : 'failed',
            state: 'started',
            result: completed ? textOfBlocks(info.lastAssistantMessage) : undefined,
            ...(completed ? {} : stoppedOutcome(childId, info.stopReason)),
          }
        } catch (error) {
          return { agentId: childId, status: 'failed', state: 'started', ...thrownOutcome(error) }
        } finally {
          off()
          if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
        }
      }

      /**
       * Spawn path: start a managed child and await its result. The request
       * signal owns only pre-publication cancellation; once the activation
       * exists the caller cancels it through `dispose`.
       */
      const start = async (
        task: SwarmTask,
        signal: AbortSignal,
        onStarted: (agentId: string) => void,
      ): Promise<SwarmAttemptResult> => {
        let activation: SubagentActivation
        try {
          const maxDepth = ctx.subagents.resolveMaxDepth()
          activation = await ctx.subagents.startActivation({
            provider: task.kind === 'fork' ? FORK_PROVIDER : SUBAGENT_PROVIDER,
            label: task.description,
            request: {
              prompt: [{ type: 'text', text: task.prompt }],
              parent,
              ...(maxDepth === undefined ? {} : { maxDepth }),
              ...(task.agentPreset === undefined || task.kind === 'fork' ? {} : { agentPreset: task.agentPreset }),
              ...(task.model === undefined || task.kind === 'fork'
                ? {}
                : {
                    agentOptions: {
                      ...(task.model.provider !== undefined ? { provider: task.model.provider } : {}),
                      model: task.model.model,
                    },
                  }),
            },
            signal,
            delivery: 'caller',
          })
        } catch (error) {
          return { agentId: undefined, status: 'failed', state: 'not_started', ...thrownOutcome(error) }
        }
        onStarted(activation.childId)
        const stop = (): void => {
          activation.dispose().catch((error: unknown) => {
            ctx.logger.warn(`failed to stop subagent ${activation.childId}: ${String(error)}`)
          })
        }
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
        try {
          const result = await activation.result
          const completed = result.stopReason === 'completed'
          return {
            agentId: activation.childId,
            status: completed ? 'completed' : 'failed',
            state: 'started',
            result: textOf(result),
            ...(completed ? {} : stoppedOutcome(activation.childId, result.stopReason)),
          }
        } catch (error) {
          return { agentId: activation.childId, status: 'failed', state: 'started', ...thrownOutcome(error) }
        } finally {
          signal.removeEventListener('abort', stop)
        }
      }

      const spawn: SpawnFn = (task, signal, attempt) => {
        // A rate-limited child keeps what it already did: continue it, as Kimi's retry does.
        if (attempt.retryAgentId !== undefined) return resume(attempt.retryAgentId, RETRY_PROMPT, signal, attempt.onStarted)
        if (task.kind !== 'resume') return start(task, signal, attempt.onStarted)
        if (task.resumeAgentId === undefined) {
          return Promise.resolve({
            agentId: undefined,
            status: 'failed',
            state: 'not_started',
            error: 'resume task is missing resumeAgentId',
          })
        }
        return resume(task.resumeAgentId, task.prompt, signal, attempt.onStarted)
      }

      // Live progress: every status change is pushed over the SSE route so
      // the chat card can render status rows while the batch is running. The
      // broadcaster coalesces ordinary frames; terminal transitions bypass it.
      const scheduler = new SwarmScheduler(spawn, {
        timeoutMs: config.timeoutMs.get(),
        maxConcurrency: config.maxConcurrency.get(),
        onProgress: (subagents) => {
          broadcaster.publish({ sessionId: parent.id, callId: exec.callId, subagents })
        },
      })
      const stopObservingTools = ctx.on('tools/result', (childExec) => {
        if (childExec.agent !== undefined) scheduler.toolResult(childExec.agent.id, childExec.name)
      })
      try {
        const results = await scheduler.run(normalized.tasks, exec.signal)
        // The host replaces a value returned after cancellation with a bare
        // "tool call aborted" but keeps a thrown error's message, and only that
        // reaches the model's next turn with the finished work and agent ids.
        if (exec.signal.aborted) throw new Error(renderSwarmResults(results))
        return { subagents: results.map(toResultRow) }
      } finally {
        stopObservingTools()
        stopRecordingFailures()
        broadcaster.finish(exec.callId, parent.id)
      }
    },
  })
}
