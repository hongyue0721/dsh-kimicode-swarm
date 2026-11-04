/** Native tool card driven by session-scoped snapshots and durable result metadata. */
import { memo, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'
import { Button, DisclosureRow, MarkdownText, SegmentedControl, StateDot, Tag, TextShimmer, Tooltip, type MarkdownLabels, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SwarmProgressEntry } from '../core/scheduler.ts'
import { dropSwarmProgress, getSwarmProgress, subscribeSwarmProgress } from './progress-store.ts'
import { NS, type SwarmTranslate } from './locales.ts'
import css from './swarm.module.css'

export interface SwarmCardActions { swarmSessionId: string; openAgent?: (id: string) => void }
export type SwarmCardProps = ToolCallOwnerProps & SwarmCardActions & PropsLocale<typeof NS>
export interface SwarmSubagentView {
  index: number; item: string | null; type: string | null; model: string | null
  status: 'completed' | 'failed' | 'aborted'; state: string | null; agentId: string | null
  error: string | null; result: string | null
  startedAt?: number; settledAt?: number; retries?: number; toolCalls?: number; activity?: string
}
export interface SwarmMetaView { description?: string; subagents?: SwarmSubagentView[] }
type CardRow = SwarmProgressEntry & { fullItem?: string; result?: string | null; error?: string | null }
const dots: Record<CardRow['status'], StateDotState> = {
  completed: 'done', failed: 'error', aborted: 'idle', running: 'ongoing', queued: 'idle', rate_limited: 'warning',
}
const busy = (status: CardRow['status']): boolean => ['queued', 'running', 'rate_limited'].includes(status)

function parseMeta(meta: unknown): SwarmMetaView | undefined {
  if (typeof meta !== 'object' || meta === null || !Array.isArray((meta as SwarmMetaView).subagents)) return undefined
  return meta as SwarmMetaView
}
function parseArgs(raw: string | undefined): { description?: string; count?: number; items?: string[]; resumeCount?: number } {
  if (raw === undefined) return {}
  try {
    const args = JSON.parse(raw)
    const resumeCount = Object.keys(args.resume_agent_ids ?? {}).length
    const count = (args.items?.length ?? 0) + resumeCount
    return { description: args.description, count: count > 0 ? count : undefined, resumeCount,
      items: args.items?.map((entry: string | { item: string }) => typeof entry === 'string' ? entry : entry.item) }
  } catch { return {} }
}
export function duration(start: number | undefined, end: number): string {
  if (start === undefined) return '—'
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
function useClock(running: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}
function RowBody({ row, t, labels }: { row: CardRow; t: SwarmTranslate; labels: MarkdownLabels }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const text = row.status === 'completed' ? row.result : row.error
  return <div className={`${css.rowBody} ${row.status === 'failed' ? css.bad : ''}`}>
    {row.status === 'completed' ? <MarkdownText text={text ?? ''} labels={labels} variant="compact" />
      : <p className={css.errorText}>{text}</p>}
    <Button size="sm" onClick={() => {
      navigator.clipboard.writeText(text ?? '').then(() => { setCopied(true); setCopyError(null) },
        (error: unknown) => setCopyError(String(error)))
    }}>{t(copied ? 'copied' : 'copy')}</Button>
    {copyError !== null && <span role="alert">{t('copyFailed', { error: copyError })}</span>}
  </div>
}
/** A settled row states its outcome; only a live row reports what the child is doing. */
function rowActivity(row: CardRow, now: number, t: SwarmTranslate): string {
  if (row.status === 'rate_limited' && row.retryAt !== undefined) {
    return t('retry', { seconds: Math.max(0, Math.ceil((row.retryAt - now) / 1000)) })
  }
  if (row.status === 'failed' || row.status === 'aborted' || row.status === 'queued') return t(row.status)
  const parts = [row.activity, row.toolCalls ? t('tools', { count: row.toolCalls }) : undefined].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : t(row.status)
}

interface RowProps {
  row: CardRow; now: number; t: SwarmTranslate; labels: MarkdownLabels; firstFailure: boolean
  useDisclosure: ToolCallOwnerProps['useDisclosure']; openAgent?: (id: string) => void
}
const SwarmRow = memo(function SwarmRow({ row, now, t, labels, firstFailure, useDisclosure, openAgent }: RowProps): JSX.Element {
  const disclosure = useDisclosure()
  const initialized = useRef(false)
  useEffect(() => {
    if (firstFailure && !initialized.current) { initialized.current = true; disclosure.setExpanded(true) }
  }, [firstFailure, disclosure.setExpanded])
  const activity = rowActivity(row, now, t)
  const expandable = row.result != null || row.error != null
  return <li className={css.row} data-status={row.status}>
    <div className={css.rowLine}>
      <Tooltip label={t(row.status)} portal><span className={css.state}><StateDot state={dots[row.status]} size={10} /></span></Tooltip>
      <Tooltip label={row.fullItem ?? row.item ?? t('resume')} portal><button className={css.rowItem} type="button" disabled={!expandable}
        aria-expanded={expandable ? disclosure.expanded : undefined} onClick={disclosure.toggle}>
        <TextShimmer active={row.status === 'running'}>{row.item ?? t('resume')}</TextShimmer>
      </button></Tooltip>
      {expandable && <span className={css.chevron} aria-hidden="true">{disclosure.expanded ? '▾' : '▸'}</span>}
      {row.type !== null && <Tooltip label={row.type} portal><span className={css.rowType}><Tag tone="quiet">{row.type}</Tag></span></Tooltip>}
      {row.model !== null && <Tooltip label={row.model} portal><span className={css.rowModel}>{row.model}</span></Tooltip>}
      <Tooltip label={activity} portal><span className={`${css.rowActivity} ${row.status === 'failed' ? css.bad : ''}`}>{activity}</span></Tooltip>
      <span className={css.elapsed}>{duration(row.startedAt, row.settledAt ?? now)}</span>
      {row.agentId !== undefined && openAgent !== undefined && <Tooltip label={t('openAgent')} portal>
        <Button size="sm" className={css.openAgent} aria-label={t('openAgent')} onClick={() => openAgent(row.agentId!)}>↗</Button>
      </Tooltip>}
    </div>
    {disclosure.expanded && expandable && <RowBody row={row} t={t} labels={labels} />}
  </li>
}, (a, b) => {
  const sameRow = Object.keys({ ...a.row, ...b.row }).every((key) => a.row[key as keyof CardRow] === b.row[key as keyof CardRow])
  return sameRow && (!busy(a.row.status) || a.now === b.now) && a.t === b.t && a.labels === b.labels &&
    a.firstFailure === b.firstFailure && a.openAgent === b.openAgent && a.useDisclosure === b.useDisclosure
})

function ProgressBar({ rows, total, t }: { rows: CardRow[]; total: number; t: SwarmTranslate }): JSX.Element {
  const completed = rows.filter((row) => row.status === 'completed').length
  const segments = ['completed', 'failed', 'aborted', 'running', 'rate_limited', 'queued'] as const
  return <div className={css.progress} role="progressbar" aria-label={t('progress')} aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}>
    {segments.map((status) => <span key={status} className={css[status]} style={{ width: `${total === 0 ? 0 : rows.filter((r) => r.status === status).length / total * 100}%` }} />)}
  </div>
}

/** Owner disclosures preserve the enclosing turn's reset behavior. */
export function SwarmCard(props: SwarmCardProps): JSX.Element {
  const { callId, swarmSessionId, t, useDisclosure, openAgent } = props
  const settled = props.phase === 'result'
  const [liveRows, setLiveRows] = useState(() => getSwarmProgress(callId, swarmSessionId))
  const [filter, setFilter] = useState<'all' | 'active' | 'failures'>('all')
  const filterId = useId()
  const list = useDisclosure()
  const raw = useDisclosure()
  const now = useClock(!settled)
  useEffect(() => {
    if (settled) { dropSwarmProgress(callId, swarmSessionId); return }
    setLiveRows(getSwarmProgress(callId, swarmSessionId))
    return subscribeSwarmProgress((id, entries, sessionId) => {
      if (id === callId && sessionId === swarmSessionId) setLiveRows(entries)
    })
  }, [callId, swarmSessionId, settled])
  const meta = settled ? parseMeta(props.block.meta) : undefined
  const args = parseArgs(props.phase === 'start' ? props.block.argsRaw : settled ? props.block.call?.argsRaw : undefined)
  const text = settled ? props.block.content.map((block: ContentBlock) => block.type === 'text' ? block.text : '').join('').trim() : ''
  const rows: CardRow[] = meta?.subagents?.map((row) => ({ ...row, agentId: row.agentId ?? undefined })) ??
    (liveRows ?? []).map((row) => ({ ...row, fullItem: args.items?.[row.index - (args.resumeCount ?? 0) - 1],
      status: settled && busy(row.status) ? 'aborted' : row.status }))
  const allCompleted = settled && rows.length > 0 && rows.every((row) => row.status === 'completed')
  useEffect(() => { list.setExpanded(!allCompleted) }, [allCompleted, list.setExpanded])
  const copyLabel = t('copy'), copiedLabel = t('copied'), footnotes = t('footnotes')
  const labels = useMemo<MarkdownLabels>(() => ({ code: { copyLabel, copiedLabel }, footnotes }), [copyLabel, copiedLabel, footnotes])
  const rawXml = text.includes('<agent_swarm_result>')
  const cancelled = rawXml || (settled && props.block.error?.code === 'ABORTED') || rows.some((row) => row.status === 'aborted')
  if (settled && props.block.isError && meta === undefined && rows.length === 0 && !cancelled) {
    return <div className={css.denied} role="status">{t('denied', { error: text.replace(/^Error:\s*/, '') })}</div>
  }
  const count = (status: CardRow['status']): number => rows.filter((row) => row.status === status).length
  const total = rows.length || args.count || 0
  const firstFailure = rows.find((row) => row.status === 'failed')?.index
  const starts = rows.flatMap((row) => row.startedAt === undefined ? [] : [row.startedAt])
  const end = settled ? props.block.time : now
  const visible = rows.filter((row) => filter === 'all' || (filter === 'active' ? busy(row.status) : row.status === 'failed'))
  return <section className={css.card} data-swarm-call={callId}>
    <DisclosureRow icon={null} title={`${t('title')} · ${meta?.description ?? args.description ?? t('task')}`} open={list.expanded}
      expandable={rows.length > 0} onToggle={list.toggle} expandOnRowClick
      collapsedContent={<span className={css.headerStats}>{count('completed')} / {total} <span className={css.elapsed}>{duration(starts.length ? Math.min(...starts) : undefined, end)}</span></span>}
      keepContentWhenOpen className={css.header}>
      <ProgressBar rows={rows} total={total} t={t} />
      <div className={css.summary} aria-live="polite">
        <span>{t('counts', { completed: count('completed'), failed: count('failed'), aborted: count('aborted'), running: count('running'), queued: count('queued'), limited: count('rate_limited') })}</span>
        {rows.length > 8 && <SegmentedControl id={filterId} value={filter} onChange={setFilter} label={t('progress')}
          options={(['all', 'active', 'failures'] as const).map((value) => ({ value, label: t(value) }))} />}
      </div>
      <ul className={css.rows}>{visible.map((row) => <SwarmRow key={row.index} row={row} now={end} t={t} labels={labels}
        firstFailure={row.index === firstFailure} useDisclosure={useDisclosure} openAgent={openAgent} />)}</ul>
    </DisclosureRow>
    {!list.expanded && <div className={css.summary} aria-live="polite">{t('counts', { completed: count('completed'), failed: count('failed'), aborted: count('aborted'), running: count('running'), queued: count('queued'), limited: count('rate_limited') })}</div>}
    {settled && cancelled && <div className={css.hint}>{t('cancelled')}</div>}
    {settled && meta === undefined && text !== '' && <DisclosureRow icon={null} title={t('raw')} open={raw.expanded} expandable onToggle={raw.toggle} expandOnRowClick>
      <pre className={css.raw}>{text}</pre>
    </DisclosureRow>}
  </section>
}
