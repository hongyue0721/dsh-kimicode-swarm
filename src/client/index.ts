/**
 * Browser half of dsh-swarm — runs inside the dsh web GUI.
 *
 * Registers two surfaces:
 * 1. A keyed `tool.call.toolview` view for `swarm_batch` calls: the in-chat
 *    swarm panel (per-subagent status rows, expandable results).
 * 2. A plugin settings card (`web-ui.plugin.item`) editing the swarm settings
 *    namespace: master switches plus the type -> model mapping table, with
 *    provider/model options pulled live from the host's `llm.models` catalog.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'tool.call.toolview' SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SwarmCard, type SwarmCardProps } from './SwarmCard.tsx'
import {
  SwarmSettingsCard,
  SwarmSettingsCardController,
  type SwarmSettings,
  type SwarmSettingsCardFace,
} from './SwarmSettingsCard.tsx'
import { publishSwarmProgress } from './progress-store.ts'

export type { SwarmCardProps } from './SwarmCard.tsx'
export type { SwarmSettings, SwarmSettingsCardFace } from './SwarmSettingsCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The child slot the Web UI plugin group declares; the swarm card registers into it. */
    'web-ui.plugin.item': { kind: 'list'; scope: 'root'; owner: SwarmSettingsPluginItemOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SwarmSettingsPluginItemOwnerProps {
  children?: never
}

/** Services required by this plugin. The settings scope binder requires the
 * caller to inject `connection` (transport) and `remote` (forwarded settings
 * invalidation) — see dsh-client-ui-settings settings-scope docs. */
export const inject = ['slots', 'settingsScope', 'connection', 'remote']

/**
 * Open a mux stream and forward every swarm/progress session event into the
 * module store, so running SwarmCard components get live per-subagent status.
 * The stream lives for the plugin lifetime; the card reads the store.
 */
function startProgressStream(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) return
  const controller = new AbortController()
  void (async () => {
    const stream = connection.api.events.mux({}, controller.signal)
    for await (const frame of stream) {
      const payload = frame.payload
      if (payload === undefined || payload.type !== 'session/event') continue
      const event = payload.event
      if (event?.type !== 'swarm/progress') continue
      publishSwarmProgress(event.data.callId, event.data.subagents)
    }
  })().catch(() => {
    // Stream teardown / transport errors are non-fatal for the cards.
  })
  ctx.effect(() => () => controller.abort(), 'dsh-swarm: progress mux')
}

/** Register the swarm surfaces. */
export function apply(ctx: ClientContext & Context): void {
  startProgressStream(ctx)

  // In-chat swarm panel: own how swarm_batch calls render inside a turn.
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'swarm_batch' }, SwarmCard),
  )

  // Plugin settings card bound to the `swarm` namespace.
  const settingsScope = ctx.settingsScope.bind<SwarmSettings>({ namespace: 'swarm' })
  const controller = new SwarmSettingsCardController(settingsScope, () => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    return connection?.api
  })
  ctx.slots.inject('web-ui.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'web-ui.plugin.item',
        id: 'dsh-swarm',
        order: 100,
        inject: () => controller.inject(),
      },
      SwarmSettingsCard,
    ),
  )
}
