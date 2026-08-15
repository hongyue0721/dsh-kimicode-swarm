/**
 * Standalone tsdown config for dsh-kimicode-swarm.
 *
 * Uses the vendored client-bundle preset (build/tsdown.client.ts — a copy of
 * the dsh-web-ui family's shared preset): closure-factory artifact for
 * window.__ModuleLoader__, CSS Modules inlined, externals resolved through
 * the loader module table. The node half builds from src (tsdown compiles TS
 * directly) and types ship from lib/types (tsc). Host-side SDK services
 * (tools/subagents/settings/commands) are externals: the host profile already
 * composes them, so the bundle must not duplicate them.
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('dsh-kimicode-swarm', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-commands',
  ],
})
