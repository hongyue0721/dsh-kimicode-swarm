/**
 * Host loader entry for the dsh-swarm plugin — runs in the DSH host process.
 *
 * Registers the `swarm_batch` tool (batch-parallel subagent dispatch with the
 * Kimi-style adaptive scheduler), a settings namespace for the model-mapping
 * table, and a system-prompt announcement so every agent knows the tool and
 * how to use it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the ctx.commands Context merge.
import type {} from '@deepseek-ai/dsh-commands'
// Module augmentation: the swarm/progress session event type.
import './events.ts'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { normalizeSwarmArgs, type ModelResolver } from './core/normalize.ts'
import { SwarmScheduler } from './core/scheduler.ts'
import {
  PROMPT_TEMPLATE_PLACEHOLDER,
  SwarmArgsError,
  swarmParameters,
  type SwarmRunResult,
  type SwarmTask,
  type SwarmToolArgs,
} from './core/types.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Subagent provider name (registered by @deepseek-ai/dsh-subagent-spawn-in-process). */
const SUBAGENT_PROVIDER = 'spawn'

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SWARM_GUIDANCE =
  '本机已安装 dsh-swarm 插件（批量并行子 Agent 调度）：工具 `swarm_batch` 可一次派发最多 128 个' +
  '独立子任务并行执行（prompt_template + items 批量生成，模板占位符按工具参数描述使用；也可 resume_agent_ids 断点续做）。' +
  '适合批量代码审查、互不依赖的多文件重构、并行调研、批量生成。' +
  '模型分配三级策略：item 级/整批显式 model > 设置映射表（按 type 命中）> 继承调用者模型（默认，由 agent 自由分配）。' +
  '调度自动渐进式启动与限流退避；用户可随时取消，已完成结果保留。' +
  '不适合强依赖串行任务与单文件深度修改（拆分反而增加合并成本）。' +
  '用户提到「swarm / 批量并行 / 并行子任务」时即指本插件，请据此协作。'

/** Settings namespace of the swarm plugin (spelled here and in the browser half). */
export const SWARM_SETTINGS_NAMESPACE = settingsNamespace('swarm')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (tool + announcement). */
  enabled?: boolean
  /** When true, dispatch resolves models through the mapping table. */
  modelMappingEnabled?: boolean
  /** Type -> model mapping table rows. */
  modelMapping?: Array<{
    type: string
    provider: string
    model: string
  }>
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
  modelMappingEnabled: z.boolean().default(false),
  modelMapping: z
    .array(
      z.object({
        type: z.string(),
        provider: z.string().default(''),
        model: z.string(),
      }),
    )
    .default([]),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true

/** Rate-limit detection from an error message (provider-agnostic heuristics). */
function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('quota') ||
    lower.includes('限流')
  )
}

/** Subagent text output, joined across blocks. */
function textOf(result: SubagentResult): string {
  return result.output
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

/** Render settled runs in the Kimi-style XML form the model can parse. */
export function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((r) => r.status === 'completed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const aborted = results.filter((r) => r.status === 'aborted').length
  const summary = [
    completed > 0 ? `completed: ${completed}` : '',
    failed > 0 ? `failed: ${failed}` : '',
    aborted > 0 ? `aborted: ${aborted}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const shouldResume = failed > 0 || aborted > 0
  const lines = ['<agent_swarm_result>', `<summary>${summary}</summary>`]
  if (shouldResume) {
    lines.push(
      '<resume_hint>Call swarm_batch with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    )
  }
  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${escapeXml(result.agentId)}"`
    const item = result.task.item === undefined ? '' : ` item="${escapeXml(result.task.item)}"`
    const state = result.state === undefined ? '' : ` state="${result.state}"`
    const body =
      result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error')
    lines.push(
      `<subagent${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    )
  }
  lines.push('</agent_swarm_result>')
  return lines.join('\n')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Apply the host half: settings namespace + announcement + tool/command
 * registration.
 * @param ctx - the plugin context (systemPrompt/tools/subagents/commands injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const inject = ['systemPrompt', 'tools', 'subagents', 'commands', 'settings']
export function apply(ctx: Context, config?: Config): void {
  let current: () => Config = () => config ?? {}
  let disposeSection: (() => void) | undefined
  let disposeTool: (() => void) | undefined
  let disposeCommand: (() => void) | undefined

  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeTool !== undefined) {
      disposeTool()
      disposeTool = undefined
    }
    if (disposeCommand !== undefined) {
      disposeCommand()
      disposeCommand = undefined
    }
    if ((current().enabled ?? true) === false) return
    if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === true) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-swarm',
        order: SECTION_ORDER,
        text: SWARM_GUIDANCE,
      })
    }
    disposeTool = ctx.tools.register(swarmTool(ctx, current))
    disposeCommand = ctx.commands.register({
      name: 'swarm',
      description: 'batch-parallel subagent dispatch: /swarm <task description>',
      input: { hint: '<task description>' },
      handler: (invocation) => {
        const task = invocation.rawInput.trim()
        if (task.length === 0) {
          return {
            kind: 'error',
            text: 'Swarm task is required. Usage: /swarm <task description>',
          }
        }
        // One-shot swarm mode, mirroring Kimi Code's task-triggered swarm:
        // the agent explores the task boundary, splits it into independent
        // sub-tasks, dispatches them in parallel through swarm_batch, then
        // summarizes — and the mode ends with the task.
        invocation.agent.steer(
          createUserMessage({
            content: [
              {
                type: 'text',
                text:
                  '你现在处于 Swarm 模式（一次性任务）。遵循以下工作流：\n' +
                  '1. 先做少量探索性工作确认任务边界（必要时读取项目结构）；\n' +
                  '2. 把任务拆解为互不依赖的独立子任务，每项一个；\n' +
                  '3. 调用 swarm_batch 工具批量并行派发：prompt_template 含 {{item}} 占位符，' +
                  'items 每项对应一个子任务，每项 prompt 自包含所需背景，避免子 Agent 来回询问；\n' +
                  '4. 全部完成后汇总各子任务结果为最终答复。\n' +
                  '任务完成后自动退出 Swarm 模式，后续按普通任务处理。' +
                  `\n\n任务：${task}`,
              },
            ],
            source: { kind: 'plugin', plugin: 'dsh-swarm' },
          }),
        )
        return { kind: 'success', text: 'Swarm 模式已进入，任务已派发给 agent 执行' }
      },
    })
  }

  installSettingsSection(ctx, SWARM_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
    },
    onChange: sync,
  })

  sync()
}

/** Build the `swarm_batch` tool definition against the live settings source. */
function swarmTool(ctx: Context, getConfig: () => Config) {
  const modelResolver: ModelResolver = {
    resolve(explicit, type) {
      if (explicit !== undefined && explicit.length > 0) return { model: explicit }
      const cfg = getConfig()
      if (cfg.modelMappingEnabled !== true) return undefined
      const entry = (cfg.modelMapping ?? []).find((m) => m.type === type)
      if (entry === undefined) return undefined
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
      'each item launches one subagent. Prefer parallel swarm dispatch over sequential work ' +
      'when tasks are independent. Results come back as an <agent_swarm_result> summary; ' +
      'failed or aborted tasks can be resumed with resume_agent_ids.',
    parameters: swarmParameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (args, value) => ({
        description: args.description,
        xml: value,
        subagents: parseResultsXml(value).map((r) => ({
          index: r.task.index,
          item: r.task.item ?? null,
          type: r.task.type ?? null,
          model: r.task.model?.model ?? null,
          status: r.status,
          state: r.state ?? null,
          agentId: r.agentId ?? null,
          error: r.error ?? null,
          result: r.result ?? null,
        })),
      }),
    },
    execute: async (args, exec) => {
      if (exec.agent === undefined) {
        throw new Error('swarm_batch requires a caller agent context.')
      }
      let normalized
      try {
        normalized = normalizeSwarmArgs(args as unknown as SwarmToolArgs, modelResolver)
      } catch (error) {
        if (error instanceof SwarmArgsError) throw error
        throw new SwarmArgsError(`invalid swarm_batch arguments: ${String(error)}`)
      }

      const spawn = async (task: SwarmTask, signal: AbortSignal) => {
        try {
          const run = await ctx.subagents.start(SUBAGENT_PROVIDER, {
            label: task.description,
            prompt: [{ type: 'text', text: task.prompt }],
            parent: exec.agent as never,
            signal,
            agentOptions:
              task.model === undefined
                ? undefined
                : { provider: task.model.provider, model: task.model.model },
          })
          const result = await run.result
          const completed = result.stopReason === 'completed'
          return {
            agentId: run.id,
            status: completed ? ('completed' as const) : ('failed' as const),
            state: 'started' as const,
            result: textOf(result),
            error: completed ? undefined : `subagent stopped: ${result.stopReason}`,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            agentId: undefined,
            status: 'failed' as const,
            state: 'not_started' as const,
            error: message,
            rateLimited: isRateLimitError(message),
          }
        }
      }

      // Live progress: every status change is appended as a swarm/progress
      // session event so the chat card can render per-subagent status rows
      // while the batch is still running.
      const session = exec.agent.session
      const scheduler = new SwarmScheduler(spawn, {
        onProgress: (subagents) => {
          session.append('swarm/progress', { callId: exec.callId, subagents })
        },
      })
      const results = await scheduler.run(normalized.tasks, exec.signal)
      return renderSwarmResults(results)
    },
  })
}

/** Re-parse the XML we just rendered into structured rows for presentation. */
function parseResultsXml(xml: string): SwarmRunResult[] {
  const rows: SwarmRunResult[] = []
  const pattern = /<subagent ([^>]*)>([\s\S]*?)<\/subagent>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const attrs = match[1]
    const body = match[2]
    const attr = (name: string): string | undefined => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(attrs)
      return found?.[1]
    }
    const status = (attr('outcome') ?? 'failed') as SwarmRunResult['status']
    rows.push({
      task: {
        index: rows.length + 1,
        kind: attr('mode') === 'resume' ? 'resume' : 'spawn',
        item: attr('item'),
        prompt: '',
        type: undefined,
        model: undefined,
        resumeAgentId: undefined,
        description: '',
      },
      agentId: attr('agent_id'),
      status,
      state: attr('state') as SwarmRunResult['state'] | undefined,
      error: status === 'completed' ? undefined : body.trim(),
      result: status === 'completed' ? body.trim() : undefined,
    })
  }
  return rows
}
