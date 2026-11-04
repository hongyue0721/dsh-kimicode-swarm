/**
 * Browser half of dsh-swarm — runs inside the dsh web GUI.
 *
 * Registers two surfaces:
 * 1. A keyed `tool.call.toolview` view for `swarm_batch` calls: the in-chat
 *    swarm panel (per-subagent status rows, expandable results).
 * 2. The plugin's configuration page (`plugins.bundle.config`, keyed by the
 *    package name) editing the type -> model mapping table, with provider/model
 *    options pulled live from the host's model catalog.
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { NS, zh, en } from './locales.ts'
import { SwarmBadge } from './SwarmBadge.tsx'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the session Remote namespace merge (ctx.remote.session).
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the configuration-form Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the 'tool.call.toolview' SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the 'plugins.bundle.config' SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SwarmCard } from './SwarmCard.tsx'
import {
  SwarmSettingsCard,
  SwarmSettingsCardController,
  type SwarmSettings,
} from './SwarmSettingsCard.tsx'
import { openProgressStream } from './progress-stream.ts'

export type { SwarmCardProps } from './SwarmCard.tsx'
export type { SwarmSettings, SwarmSettingsCardFace } from './SwarmSettingsCard.tsx'

/** Package name: keys this plugin's page on the Plugins page. */
const PACKAGE_NAME = 'dsh-kimicode-swarm'

/** Profile entry id declared by cordis.patch.yml; names the settings namespace. */
const SETTINGS_ENTRY_ID = 'dsh-kimicode-swarm'

/** Services required by this plugin. */
export const inject = ['slots', 'configForms', 'remote', 'remote.session', 'remote.commands', 'locale']

/** Register the swarm surfaces. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-swarm: dictionaries')
  ctx.effect(() => openProgressStream(), 'dsh-swarm: progress sse')

  // In-chat swarm panel: own how swarm_batch calls render inside a turn.
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'swarm_batch', locale: NS, inject: (sessionId) => ({
      swarmSessionId: sessionId, ...childNavigation(ctx, sessionId),
    }) }, SwarmCard),
  )

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register({ name: 'conversation.input.left', id: 'kimicode-swarm', locale: NS, inject: (sessionId) => ({
      swarmSessionId: sessionId,
      disableMode: async () => {
        const result = await ctx.remote.commands.execute(sessionId as SessionId, '/swarm off', [])
        if (!result.ok) throw new Error(result.error.message)
        if (result.value === undefined) throw new Error(ctx.locale.bind(NS)('commandUnavailable'))
        if (result.value.result.kind === 'error') throw new Error(result.value.result.text)
      },
    }) }, SwarmBadge),
  )

  // Presets only offer input suggestions, and a profile may compose no registry.
  let listPresets: Context['remote']['agentPresets']['list'] | undefined
  ctx.inject(['remote.agentPresets'], (scope) => {
    listPresets = () => scope.remote.agentPresets.list()
    scope.effect(() => () => { listPresets = undefined }, 'dsh-swarm: preset suggestions')
  })

  const controller = new SwarmSettingsCardController(
    ctx.configForms.get<SwarmSettings>(SETTINGS_ENTRY_ID),
    async () => {
      const reply = await ctx.remote.session.modelCatalog()
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.value
    },
    async () => {
      if (listPresets === undefined) return []
      const result = await listPresets()
      if (!result.ok) {
        if (result.error.code === 'gateway/invocation-unavailable') return []
        throw new Error(result.error.message)
      }
      return result.value.presets.map((preset) => preset.id)
    },
  )
  ctx.effect(() => () => { controller.dispose() }, 'dsh-swarm: settings form')
  ctx.effect(
    () =>
      ctx.configForms.whileServed([SETTINGS_ENTRY_ID], () =>
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS, inject: () => controller.inject() },
            SwarmSettingsCard,
          ),
        ),
      ),
    'dsh-swarm: settings page',
  )
}

/** Match the host subagent UI's durable parent/child address. */
function childNavigation(ctx: Context, parentSessionId: string): { openAgent?: (id: string) => void } {
  const workspace = ctx.get('uiWorkspace')
  const sidebar = ctx.get('sidebarRight')
  if (workspace === undefined && sidebar === undefined) return {}
  return { openAgent: (id) => {
    const address = { parentSessionId: parentSessionId as SessionId, childSessionId: id as SessionId, mode: 'continuable' as const }
    if (workspace !== undefined) workspace.openSession(address)
    else sidebar!.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(id)}?${new URLSearchParams({ parent: parentSessionId, mode: 'continuable' })}`, { kind: 'subagentchat', preferNewPane: true })
  } }
}
