/**
 * Package entry point for opencode-discord-presence.
 *
 * Exposes a dual V1 + V2 plugin:
 *
 *   - OpenCode V2 (>= 2.0.x) reads the `id` / `setup` fields and calls
 *     `setup(ctx)`.
 *   - OpenCode V1 (1.18.29+) reads the legacy `server` field and calls it with
 *     the V1 `PluginInput`.
 *
 * The V1 implementation is exported unchanged as `server` (and as the named
 * `OpenCodeDiscordPresence` export) so existing consumers and tests keep
 * working, while the V2 adapter lives in `./v2.ts`.
 */
import { OpenCodeDiscordPresence } from "./plugin.js"
import { openCodeDiscordPresenceV2 } from "./v2.js"

export default {
  id: openCodeDiscordPresenceV2.id,
  setup: openCodeDiscordPresenceV2.setup,
  server: OpenCodeDiscordPresence,
}

// Named export retained for V1 consumers (and existing tests) that import the
// legacy hook function directly.
export { OpenCodeDiscordPresence }

// Re-export the V2 building blocks for consumers that need them.
export { createClientShim, openCodeDiscordPresenceV2, PLUGIN_ID, translateV2Event } from "./v2.js"
