/**
 * In-chat swarm panel: the keyed `tool.call.toolview` view for `swarm_batch`.
 *
 * While the call runs it renders live per-subagent status rows fed by the
 * host's swarm/progress session events (queued -> running -> settled), like
 * Kimi Code's parallel swarm list. After settlement it renders the full panel
 * from the tool's `presentationMeta` (structured `subagents` riding the
 * result node's `meta`), with expandable result bodies. Falls back to the
 * result text when the meta is absent.
 */
import { useEffect, useState, type JSX } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SwarmProgressEntry } from '../core/scheduler.ts'
import { dropSwarmProgress, getSwarmProgress, subscribeSwarmProgress } from './progress-store.ts'
import css from './swarm.module.css'

/** Card props: the owner payload (locale seat omitted — fixed English copy). */
export type SwarmCardProps = ToolCallOwnerProps

/** Structured subagent row produced by the host's presentationMeta. */
export interface SwarmSubagentView {
  index: number
  item: string | null
  type: string | null
  model: string | null
  status: 'completed' | 'failed' | 'aborted'
  state: string | null
  agentId: string | null
  error: string | null
  result: string | null
}

/** Structured presentation meta (mirror of the host projection). */
export interface SwarmMetaView {
  description?: string
  xml?: string
  subagents?: SwarmSubagentView[]
}

/** Status copy for both live progress rows and settled rows. */
const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
}

function parseMeta(meta: unknown): SwarmMetaView | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const candidate = meta as SwarmMetaView
  if (!Array.isArray(candidate.subagents)) return undefined
  return candidate
}

/** Parse the raw arguments JSON of a running call (best effort). */
function parseArgs(argsRaw: string): { description?: string; count?: number } {
  try {
    const parsed = JSON.parse(argsRaw) as {
      description?: string
      items?: unknown[]
      resume_agent_ids?: Record<string, unknown>
    }
    const itemCount = parsed.items?.length ?? 0
    const resumeCount = parsed.resume_agent_ids !== undefined
      ? Object.keys(parsed.resume_agent_ids).length
      : 0
    const count = itemCount + resumeCount
    return { description: parsed.description, count: count > 0 ? count : undefined }
  } catch {
    return {}
  }
}

function summarizeContent(block: ToolCallBlock): string {
  if (!('content' in block)) return ''
  return block.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim()
}

/** One live progress row (queued/running/settled), keyed by index. */
function LiveRow({ row, open, onToggle }: {
  row: SwarmProgressEntry
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <li className={css.row}>
      <button
        type="button"
        className={`${css.rowHead} ${row.status === 'failed' ? css.rowFailed : ''}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={`${css.dot} ${css[row.status] ?? css.queued}`} />
        <span className={row.status === 'running' ? css.rowRunning : css.rowItem}>
          {row.item ?? '(resume)'}
        </span>
        {row.type !== null ? <span className={css.rowType}>{row.type}</span> : null}
        {row.model !== null ? <span className={css.rowModel}>{row.model}</span> : null}
        <span className={`${css.rowStatus} ${css[`status-${row.status}`] ?? ''}`}>
          {STATUS_LABEL[row.status] ?? row.status}
        </span>
      </button>
    </li>
  )
}

/** Render the swarm call card. */
export function SwarmCard({ block }: SwarmCardProps): JSX.Element | null {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [liveRows, setLiveRows] = useState<SwarmProgressEntry[] | undefined>(() =>
    'argsRaw' in block ? getSwarmProgress(block.callId) : undefined,
  )
  const settled = 'kind' in block && block.kind === 'tool-result'
  const callId = 'argsRaw' in block ? block.callId : undefined

  // Live progress feed while the call is still running.
  useEffect(() => {
    if (settled || callId === undefined) return
    const unsubscribe = subscribeSwarmProgress((id, entries) => {
      if (id === callId) setLiveRows(entries)
    })
    const current = getSwarmProgress(callId)
    if (current !== undefined) setLiveRows(current)
    return unsubscribe
  }, [settled, callId])

  // Clean up the progress store entry after settlement (memory hygiene).
  useEffect(() => {
    if (!settled || callId === undefined) return
    return () => {
      dropSwarmProgress(callId)
    }
  }, [settled, callId])

  const args = 'argsRaw' in block ? parseArgs(block.argsRaw) : undefined
  const meta = settled && 'meta' in block ? parseMeta(block.meta) : undefined
  const text = settled ? summarizeContent(block) : undefined
  const rows = meta?.subagents ?? []
  const completed = rows.filter((r) => r.status === 'completed').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const aborted = rows.filter((r) => r.status === 'aborted').length
  const live = liveRows ?? []
  const liveCompleted = live.filter((r) => r.status === 'completed').length
  const liveFailed = live.filter((r) => r.status === 'failed').length

  return (
    <div className={css.card}>
      <div className={css.header}>
        <span className={css.title}>Swarm batch-parallel</span>
        {settled ? (
          <span className={css.summary}>
            {completed > 0 ? <em className={css.ok}>{completed} completed</em> : null}
            {failed > 0 ? <em className={css.bad}>{failed} failed</em> : null}
            {aborted > 0 ? <em className={css.muted}>{aborted} aborted</em> : null}
          </span>
        ) : (
          <span className={css.summary}>
            <em className={css.ok}>{liveCompleted} completed</em>
            {liveFailed > 0 ? <em className={css.bad}>{liveFailed} failed</em> : null}
            <em className={css.running}>Running…</em>
          </span>
        )}
      </div>
      <div className={css.description}>
        {(settled ? meta?.description : args?.description) ?? 'Batch subtasks'}
        {args?.count !== undefined ? <span className={css.count}>{args.count} items</span> : null}
      </div>
      {!settled && live.length > 0 ? (
        <ul className={css.rows}>
          {live.map((row) => (
            <LiveRow
              key={row.index}
              row={row}
              open={false}
              onToggle={() => { /* running rows are not expandable */ }}
            />
          ))}
        </ul>
      ) : settled && rows.length > 0 ? (
        <ul className={css.rows}>
          {rows.map((row) => (
            <li key={row.index} className={css.row}>
              <button
                type="button"
                className={`${css.rowHead} ${row.status === 'failed' ? css.rowFailed : ''}`}
                aria-expanded={openIndex === row.index}
                onClick={() => { setOpenIndex(openIndex === row.index ? null : row.index) }}
              >
                <span className={`${css.dot} ${css[row.status]}`} />
                <span className={css.rowItem}>{row.item ?? '(resume)'}</span>
                {row.type !== null ? <span className={css.rowType}>{row.type}</span> : null}
                {row.model !== null ? <span className={css.rowModel}>{row.model}</span> : null}
                <span className={css.rowStatus}>{STATUS_LABEL[row.status]}</span>
                <span className={css.chevron}>{openIndex === row.index ? '▾' : '▸'}</span>
              </button>
              {openIndex === row.index ? (
                <pre className={css.rowBody}>
                  {row.status === 'completed' ? (row.result ?? '') : (row.error ?? '')}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      ) : text !== undefined && text.length > 0 ? (
        <pre className={css.rowBody}>{text}</pre>
      ) : null}
    </div>
  )
}
