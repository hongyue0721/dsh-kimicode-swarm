/**
 * Browser half of dsh-swarm — runs inside the dsh web GUI.
 *
 * Registers two surfaces:
 * 1. A keyed `tool.call.toolview` view for `swarm_batch` calls: the in-chat
 *    swarm panel (per-subagent status rows, expandable results).
 * 2. A plugin settings card (`settings.plugin.item`, keyed by the `swarm`
 *    namespace) editing the swarm settings namespace: master switches plus
 *    the type -> model mapping table, with provider/model options pulled live
 *    from the host's `llm.models` catalog.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'tool.call.toolview' SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the 'settings.plugin.item' keyed-slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SwarmProgressEntry } from '../core/scheduler.ts'
import { SwarmCard, type SwarmCardProps } from './SwarmCard.tsx'
import {
  SwarmSettingsCard,
  SwarmSettingsCardController,
  type SwarmSettings,
  type SwarmSettingsCardFace,
} from './SwarmSettingsCard.tsx'
import { publishSwarmProgress, SWARM_PROGRESS_ROUTE } from './progress-store.ts'

export type { SwarmCardProps } from './SwarmCard.tsx'
export type { SwarmSettings, SwarmSettingsCardFace } from './SwarmSettingsCard.tsx'

/** Services required by this plugin. The settings scope binder requires the
 * caller to inject `connection` (transport) and `remote` (forwarded settings
 * invalidation) — see dsh-client-ui-settings settings-scope docs. */
export const inject = ['slots', 'settingsScope', 'connection']

/**
 * Open an EventSource to the host's /swarm-events route and forward every
 * progress frame into the module store, so running SwarmCard components get
 * live per-subagent status. The stream lives for the plugin lifetime; the
 * card reads the store.
 */
function startProgressStream(ctx: ClientContext): void {
  // The web UI and the host webserver are same-origin (the browser loaded the
  // UI from it), so a relative URL reaches the route without knowing the
  // host/port. On the Electron IPC bridge this resolves against the harness
  // origin as well; if the origin is unavailable the stream simply stays
  // closed and the card renders settled results only.
  const source = new EventSource(SWARM_PROGRESS_ROUTE)
  source.addEventListener('progress', (event) => {
    try {
      const frame = JSON.parse((event as MessageEvent).data) as {
        callId: string
        subagents: SwarmProgressEntry[]
      }
      publishSwarmProgress(frame.callId, frame.subagents)
    } catch {
      // Malformed frames are dropped; the next frame overwrites the store.
    }
  })
  source.onerror = () => {
    // The host may have no web server or the route may be unregistered.
    // Close to prevent silent infinite reconnection; the card falls back
    // to settled-only rendering without live progress.
    source.close()
  }
  ctx.effect(() => () => source.close(), 'dsh-swarm: progress sse')
}

/** Register the swarm surfaces. */
export function apply(ctx: ClientContext & Context): void {
  startProgressStream(ctx)

  // In-chat swarm panel: own how swarm_batch calls render inside a turn.
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'swarm_batch' }, SwarmCard),
  )

  // Plugin settings card bound to the `swarm` namespace, keyed by that
  // namespace exactly like the official shell/agent-loop/web-search cards.
  const settingsScope = ctx.settingsScope.bind<SwarmSettings>({ namespace: 'swarm' })
  const controller = new SwarmSettingsCardController(settingsScope, () => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    return connection?.api
  })
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'swarm',
        registrant: 'dsh-swarm',
        inject: () => controller.inject(),
      },
      SwarmSettingsCard,
    ),
  )
}
