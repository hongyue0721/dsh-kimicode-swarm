/** Shared policy defaults; the two-hour timeout follows the Kimi swarm design. */
export const DEFAULT_SWARM_TIMEOUT_MS = 2 * 60 * 60 * 1000
/** Swarm v2 requires explicit user authorization unless the user opts out. */
export const DEFAULT_REQUIRE_SWARM_MODE = true
/** Zero adds no plugin cap; the host's active-child limit still applies. */
export const DEFAULT_MAX_CONCURRENCY = 0
