/**
 * Load the built opencode-discord-presence plugin for OpenCode's local-directory
 * and git-package resolvers.
 *
 * OpenCode V2 resolves a plugin package/directory through its `server`
 * entrypoint (root `server.js` or the `./server` export in package.json).
 * Published packages use the equivalent `./server` export; this bridge keeps
 * local development and V1-style paths aligned with the V2 loader.
 */
export { default } from "./dist/index.js"
export * from "./dist/index.js"
