/** A session-scoped composer control; command failures remain visible. */
import { useState, useSyncExternalStore, type JSX } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { getSwarmMode, subscribeSwarmMode } from './progress-store.ts'
import { NS } from './locales.ts'
import css from './swarm.module.css'

export interface SwarmBadgeActions { swarmSessionId: string; disableMode(): Promise<void> }
export type SwarmBadgeProps = SwarmBadgeActions & PropsLocale<typeof NS>
export function SwarmBadge({ swarmSessionId, disableMode, t }: SwarmBadgeProps): JSX.Element | null {
  const mode = useSyncExternalStore(subscribeSwarmMode, () => getSwarmMode(swarmSessionId))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!mode?.active && error === null) return null
  return <span className={css.badge}>
    {mode?.active && <Tooltip label={t('modeHint')} portal><Button size="sm" variant="outline" disabled={pending} onClick={() => {
      setPending(true); setError(null)
      disableMode().catch((caught: unknown) => setError(String(caught))).finally(() => setPending(false))
    }}>{t('title')}</Button></Tooltip>}
    {error !== null && <span className={css.bad} role="alert">{t('modeOffFailed', { error })}</span>}
  </span>
}
