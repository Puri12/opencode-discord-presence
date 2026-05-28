# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-05-28

### Added

- **Last-active CLI drives Discord presence** ([#9](https://github.com/Puri12/opencode-discord-presence/issues/9), [#10](https://github.com/Puri12/opencode-discord-presence/pull/10)). When multiple OpenCode CLI instances run on the same machine, Discord Rich Presence now follows whichever CLI the user is actually typing in. Previously the first CLI to start grabbed Discord's single IPC socket and held it forever, leaving later-active CLIs silent.

  Design: each plugin writes a per-PID heartbeat under `~/.opencode-discord-presence/instances/<hostname>/<clientId>/<pid>.json` carrying `{pid, instanceId, startedAt, lastActivity, lastSeen}`. A 1 s tick refreshes own file, scans peers, and elects `max(lastActivity)` as owner. Ownership transitions disconnect the previous owner immediately and reconnect the new owner after a 1.2 s settle delay (strictly longer than the 1 s tick so the previous owner has time to clear and disconnect before the new owner contends for the IPC socket).

  Steady-state cost: ~1–2 ms CPU/sec, 1 file write/sec per instance. Discord reconnects only on actual ownership flips, and the brief gap is hidden by Discord's ~10 s presence cache. New module exports: `InstanceCoordinator`, `buildInstancesDir`, `createOwnershipHandler`, `createRecapScheduler`.

- **`process.on('SIGINT'/'SIGTERM')` shutdown path** now runs the same full teardown as the `dispose` hook — releases the primary-plugin guard, cancels pending settle/recap timers, unlinks the coordinator heartbeat, stops rotation, clears Discord activity, and disconnects RPC. Combined with [#2](https://github.com/Puri12/opencode-discord-presence/pull/2)'s lifecycle hooks, every exit path (graceful or signal-driven) leaves a clean state.

- **Multi-CLI QA scripts** under `scripts/multi-cli-coordinator-qa.ts` (21 in-process scenarios covering F1–F13 plus 3+ CLI concurrent startup and owner-stop hand-over) and `scripts/multi-process-coordinator-qa.ts` (6 scenarios using real `child_process.fork` workers to exercise cross-process file coordination).

### Fixed

- **Startup focus theft** (F1). A freshly-launched CLI no longer outranks an already-running CLI that has had recent user activity. `lastActivity` defaults to a `0` sentinel and the tied-activity tiebreak now prefers the OLDER `startedAt` then LOWER `pid` (stability over recency). Auto-reload of plugin config no longer mid-flight steals presence from another CLI either.

- **Non-atomic coordinator writes** (F2). `writeOwnFile` now writes to a `.tmp` sibling then `renameSync`, and `findWinner` only scans `.json` files. Peers can no longer observe partial JSON during a heartbeat write — eliminates the "peer file missing for one tick → ownership flap" race.

- **Cross-machine false-peer suppression** (F3/F6). The instances directory is now namespaced per `os.hostname()` and per Discord application ID. Shared-HOME setups (NFS, SMB, Dropbox, iCloud Drive) no longer make one machine's CLIs suppress another's, and users running multiple Discord application IDs no longer cross-contaminate.

- **Heartbeat write failure split-brain** (F4). `writeOwnFile()` now returns a boolean; on filesystem failure (`ENOSPC`/`EACCES`) the coordinator force-demotes itself, fires `onOwnershipChange(false)`, and skips the election for that tick. Fail-closed — if we cannot publish a heartbeat we must not own the Discord IPC.

- **Same-PID reload deletes new heartbeat** (F5). Each coordinator now carries a `instanceId` field; `stop()` reads the file first and only unlinks if the embedded `instanceId` matches own. A reload-before-dispose race can no longer delete the replacement coordinator's heartbeat.

- **Future-timestamp peer hijacks ownership** (F7). `findWinner` validates peer records against a schema (finite numbers, non-negative timestamps) and rejects any record with `lastActivity`/`lastSeen` beyond `Date.now() + allowedClockSkewMs` (default 60 s). A bogus or corrupted peer record can no longer pin ownership indefinitely.

- **Session-metrics cross-CLI clobbering** (F8). `saveSessionMetrics`/`loadSessionMetrics`/`clearSessionMetrics` accept `{ instanceId }`; per-CLI files are stored as `session-metrics-<uuid>.json`. New `pruneStaleSessionMetrics()` runs on plugin init to GC orphan files from crashed CLIs (savedAt > 30 min, with `mtime` fallback).

- **Rotation timer keeps event loop alive for non-owner** (F9). The 20 s rotation `setInterval` is now started only after ownership is confirmed and is `.unref()`'d, so a non-owner CLI exits cleanly even if other lifecycle hooks are still pending.

- **30 s recap timer leaks captured RPC** (F10). The post-session recap is now a pure visual state on the snapshot (`createRecapScheduler` clears `recapCache` after the delay). The RPC lifecycle stays tied to ownership, so dispose / ownership loss / fresh activity each cancel the recap cleanly without leaking the Discord IPC socket. `exitRecapIfNeeded()` is called from `chat.message` so user activity within the 30 s window resumes normal presence immediately.

- **Recap card never actually cleared** — the previous `updateRecapCache({})` reducer call merged the empty object and left the `timestamp` populated, pinning the "Session Complete!" card past its 30 s window. Replaced with a direct `snapshot.recapCache = {}` reset plus `void pushPresence()` so Discord receives the post-recap state immediately.

- **Discord RPC zombie state on rapid disconnect/connect** — `DiscordRPCService` now carries a monotonic `clientGeneration` counter. `connect()` captures `myGeneration` before creating the `Client`; each of the three callback paths (`ready`, `disconnected`, `login.catch`) bails on generation mismatch. `disconnect()` increments the counter to invalidate any in-flight handlers from the old client. Without this, a late `ready` from a destroyed client could flip `connected=true` while `client=null`, silently dropping every subsequent `setActivity`.

- **Owner-acquire timing race** (F11). `createOwnershipHandler` introduces a 1.2 s settle window between ownership gain and `rpc.connect()` so the previous owner has time to `clear()` + `disconnect()` before the new owner contends for Discord's single IPC socket. The settle delay is constrained to be strictly greater than the coordinator's 1 s tick interval. Ownership loss disconnects immediately. Initial owner bootstrap also routes through this path for consistent solo-CLI startup behavior.

- **Stale-peer cleanup destroys live peers across machine sleep** (F13). Stale peer files are now excluded from election immediately but only unlinked after a configurable `staleGracePeriodTicks` (default 2). After macOS/Linux wake-from-sleep, the first waking CLI no longer deletes peers that simply have not had a chance to tick yet.

- **Activity flush latency** (F12). `recordActivity({ flush: true })` writes the own file and runs `tick()` synchronously; `chat.message` uses it so a user typing in CLI B flips ownership within the same event turn instead of waiting up to 1 s for the next periodic tick.

### Verification

`bun test`: 302 pass / 0 fail (+45 vs 0.6.0). `scripts/multi-cli-coordinator-qa.ts`: 21/21 stable across 5 consecutive runs. `scripts/multi-process-coordinator-qa.ts`: 6/6 with real OS fork workers.

### Known limitations

- The `primaryPluginActive` same-PID guard is module-scoped — if OpenCode loads two physically distinct module copies in the same process they both run. Not affected by the common single-registration setup; a file-based per-PID lock would harden this further.
- SIGKILL (uncatchable) and abrupt terminal closes still bypass the shutdown hook, leaving the coordinator heartbeat on disk. The stale-cleanup grace period eventually GCs it; opening fresh CLIs is not affected.

## [0.6.0] - 2026-05-28

### Added

- **OpenCode Desktop compatibility** ([#2](https://github.com/Puri12/opencode-discord-presence/pull/2)). Replaced `Bun.file()` / `Bun.write()` with `node:fs/promises` so the plugin loads inside OpenCode Desktop's Node.js (Electron) sidecar where the global `Bun` is undefined. Plain Node.js APIs work equally well in Bun, so the TUI is unaffected.
- **Plugin lifecycle hooks** ([#2](https://github.com/Puri12/opencode-discord-presence/pull/2)). Added a `dispose` hook plus `SIGINT` / `SIGTERM` fallbacks that stop the rotation timer, clear the Discord activity, and disconnect the RPC client. Presence no longer lingers on Discord after OpenCode shuts down.

### Fixed

- **Stale presence on graceful shutdown** ([#2](https://github.com/Puri12/opencode-discord-presence/pull/2)). `disconnect()` now explicitly sends `clearActivity` before destroying the RPC client. Combined with the new lifecycle hooks above, this ensures Discord drops the presence card immediately on quit instead of holding the last state indefinitely.
- **Double `clearActivity` on session recap teardown** (review follow-up on [#2](https://github.com/Puri12/opencode-discord-presence/pull/2)). `disconnect()` now skips the `clearActivity` call when a prior `clear()` already sent one — keeps the recap-cleanup test suite GREEN and avoids hammering Discord with redundant RPC calls.
- **Spurious warn on first launch without config file** (review follow-up on [#2](https://github.com/Puri12/opencode-discord-presence/pull/2)). `loadConfigFile` silently skips `ENOENT` so users who keep only one of `<projectRoot>/.discord-presence.json` or `~/.discord-presence.json` (the common case per the README) no longer see `[discord-presence] Failed to load config file: …` on every startup. Restores the "silent by default" promise.

### Acknowledgements

Thanks to [@festivities](https://github.com/festivities) for the Desktop-compatibility work in [#2](https://github.com/Puri12/opencode-discord-presence/pull/2) — exactly the lifecycle plumbing the multi-CLI features landing next needed.

## [0.5.2] - 2026-05-28

### Added

- **"View on GitHub" button on Rich Presence** ([#5](https://github.com/Puri12/opencode-discord-presence/issues/5), [#6](https://github.com/Puri12/opencode-discord-presence/pull/6)). Every activity card now carries a single hardcoded link button pointing to the project repo, applied uniformly across all states (file spotlight, mission board, idle, recap). Note: Discord renders Rich Presence buttons only on *other users viewing the profile*, never on the user themself — same product limitation as every Discord RPC client.

## [0.5.1] - 2026-05-28

### Fixed

- **Non-blocking Discord RPC connect on init** ([#3](https://github.com/Puri12/opencode-discord-presence/issues/3), [#4](https://github.com/Puri12/opencode-discord-presence/pull/4)). OpenCode awaits the plugin init promise during bootstrap, so the ~10 s `@xhayper/discord-rpc` IPC timeout used to stall the entire UI whenever Discord desktop was not running. The plugin now starts the rotation timer and queues initial presence immediately, then fires `connect()` fire-and-forget. The existing `'ready'` replay logic in `DiscordRPCService` pushes the cached presence on every successful connect (initial or via `scheduleReconnect()`), so late Discord launches are covered without changing the service API. Extracted as `startPluginAsync` and pinned by a regression test asserting sync return even when `connect()` never resolves.

## [0.5.0] - 2026-05-27

### Added

- **Restored multi-agent state machine** (`PresenceOrchestrator`) accidentally dropped during 0.4.0 PR merge. Tracks `busySessions` Set across all chat.message events and only transitions to idle text when every tracked session reports idle.
- **`SessionTracker` service** resolves `main` vs `sub-agent` session kind via OpenCode SDK (`client.session.get`), primed by `session.created` / `session.updated` events for synchronous `peek()`. Lookups are coalesced and missing sessions are negatively cached for 5s.
- **`richPresence.mainAgentOnly` config flag** (default `false`). When `true`, sub-agent (task tool, planner, explore, etc.) chat.message events are filtered out so the user's Discord profile stays anchored to the main session. When `false`, every chat.message overwrites presence — last-writer-wins, but idle text still requires all sessions to be idle.
- **Model name visibility** — restored from 0.3.0. The active model (e.g. `claude-opus-4-7`) now prefixes the state line on all active cards (file spotlight, mission board, diagnostics, session stats). Idle/recap states omit the model.
- Restored `scripts/smoke-test.ts` and `scripts/multi-window-test.ts` adapted to the new orchestrator API (state-machine returns transition deltas; plugin layer owns rendering).
- 37 new unit tests across `presence-orchestrator.test.ts`, `session-tracker.test.ts`, and dedicated model-display assertions in `activity-rotation.test.ts`.

### Changed

- `chat.message` handler now routes through orchestrator: marks session busy, resets the Discord start timestamp on idle→busy transition, and updates the reducer-driven snapshot.
- `event` handler now consumes `session.status` (idle/busy), `session.created`, and `session.updated` events to drive the orchestrator + tracker state machine. `session.idle` and `session.deleted` route through the orchestrator as well.
- `session.deleted` for a sub-agent in `mainAgentOnly` mode no longer triggers the session recap card — that would steal the main session's presence display.
- `tool.execute.before` and `tool.execute.after` skip sub-agent sessions in `mainAgentOnly` mode (synchronous fast-path with fire-and-forget SDK resolve for unknown sessions, so high-frequency file spotlight updates are not blocked on SDK latency).

### Fixed

- Multi-agent presence flicker — sub-agent chat.message events no longer overwrite the main agent's presence when `mainAgentOnly: true`.
- Idle text never appearing after request completion — `session.status idle` now properly transitions to idle text when all tracked sessions report idle.

## [0.4.0] - 2026-05-27

### Added

- Config compatibility: `applicationId` remains the recommended top-level key, and `discordPresence.applicationId` is accepted as a backward-compatible fallback when parsing config files.
- **Korean localization for Rich Presence** — runtime presence states support `language: "ko"` with proper Korean particle handling (을/를, 은/는)
  - Idle state: `{agent}는 휴식중` / `{agent}은 휴식중` based on final consonant check
  - File spotlight: `{agent}을/를 작업중`
  - Task mission board: `{agent}을/를 작업중`
  - Diagnostics and warnings: `오류 {n}개, 경고 {m}개` / `경고 {n}개`
  - Session recap and stats line: `{n}개 프롬프트 • {m}개 파일`
  - All tasks complete: `모든 작업 완료!`, `{n}/{m} 완료`
  - English (`"en"`) remains default with `language: Language = "en"` parameter
- **Enhanced Rich Presence** — major feature update with Live File Spotlight, Task Mission Board, diagnostics-ready display scaffolding, session recap, and smart rotation
  - Live File Spotlight shows the file currently being edited/read/diagnosed with language-specific Discord icons
  - Task Mission Board displays active todo progress with completion counts (e.g., "Implementing dark mode (2/5)")
  - Diagnostics display scaffolding is present, but OpenCode plugin API v1 does not currently provide counts through `lsp.client.diagnostics`
  - Session recap shows total prompts and files touched for 30 seconds after session end
  - Informational cards rotate every 20 seconds by default (configurable 10–60s)
  - Critical states (errors, idle, all-done, recap) pin until resolved
- Added new configuration options: `richPresence.enableFileSpotlight`, `richPresence.enableMissionBoard`, `richPresence.rotationIntervalSeconds`, `richPresence.diagnostics.errorsOnly`
- Refactored plugin to use instance-scoped presence state (no more module-level mutable globals)
- Hardened Discord RPC service with explicit disconnect, throttled updates, and stale-replay prevention

### Changed

- All `[discord-presence]` lifecycle logs (connect / disconnect / failures) flow through `this.log` / `this.warn` and are gated on `config.debug` — preserved from 0.3.0, so the plugin remains silent by default after this PR merges.

### Security

- `richPresence.enableFileSpotlight` is now **`false` by default**. Discord broadcasts your activity to anyone viewing your profile, so the previous default (`true`) leaked working file paths from private repos. Opt in explicitly if you're working on a public repo or don't mind the exposure.

### Fixed

- Empty catch blocks in RPC service — replaced with structured error logging
- Potential stale replay after session deletion — guarded by `cleared` flag
- Infinite reconnect loop — `disconnect()` now prevents further reconnect attempts

## [0.3.0] - 2026-05-27

### Added

- `PresenceOrchestrator` class encapsulating the busy/idle state machine (testable, no module-level state leaks).
- Monotonic update sequence on `DiscordRPCService` to drop stale `setActivity` calls during in-process races.
- Graceful shutdown via `SIGINT` / `SIGTERM` / `exit` hooks that disconnect cleanly from Discord IPC.
- `debug` config option (file / env `OPENCODE_DISCORD_DEBUG=true`). When **false** (default), the plugin emits **zero** logs to the OpenCode console. When **true**, `[discord-presence]` lifecycle messages are printed via `console.log` / `console.warn`.
- 37 unit / integration tests across particle, config, discord-rpc, and presence-orchestrator.
- `scripts/smoke-test.ts` and `scripts/multi-window-test.ts` for live Discord IPC verification.

### Changed

- **Silent by default.** Previous versions always printed `[discord-presence] Connected to Discord` and reconnect messages. Set `debug: true` (or `OPENCODE_DISCORD_DEBUG=true`) to restore the old behavior.
- Every `chat.message` (main session OR sub-agent spawned by `task`) updates Rich Presence with the responding agent's name. Last writer wins — naturally surfaces whichever agent is currently active.
- Plugin now subscribes to `session.status` events so request completion (`status.type === "idle"`) swaps the presence to the idle text. `session.idle` is still handled as a fallback.
- Idle text (`"X is idle"` / `"X는 휴식중"`) is shown only when **every** tracked session reports idle. Single-session-idle while others are still busy keeps the latest agent's busy text.
- Multi-window setups: every plugin instance writes its own presence directly to Discord. Last writer wins through Discord IPC, so the most-recently-active window's agent is displayed.
- `src/plugin.ts` reduced to thin wiring (orchestrator + lifecycle hooks). Architecture lives in `src/services/`.

### Fixed

- Idle state is now driven by `session.status: idle` instead of waiting for `session.deleted`. The presence transitions to the idle text as soon as the request completes.
- Reconnect / disconnect logging is silenced on intentional shutdown — no more spurious `Max retries reached` line at process exit.

## [0.1.0] - 2026-01-30

### Added

- Initial release of opencode-discord-presence plugin
- Discord Rich Presence integration with OpenCode
- Real-time agent and model display
- Session time tracking with elapsed time
- Token usage tracking and formatting (e.g., "12.5k tokens")
- Project name detection from Git remote URL or directory path
- Korean particle support (을/를, 은/는) for proper Korean grammar
- Idle/active state detection
- Configuration options:
  - `enabled` - Enable/disable the plugin
  - `applicationId` - Custom Discord Application ID
  - `showSessionTime` - Toggle session time display
  - `showTokenUsage` - Toggle token usage display
  - `showProjectName` - Toggle project name display
- Singleton Discord RPC service with:
  - Automatic reconnection with exponential backoff
  - Debounced presence updates to avoid rate limiting
- Comprehensive test suite with 42+ tests
- Full TypeScript support with type definitions
- Biome linting and formatting

### Technical Details

- Built with Bun runtime
- Uses @xhayper/discord-rpc for Discord integration
- Follows OpenCode plugin architecture with `@opencode-ai/plugin`
- TDD development approach

[Unreleased]: https://github.com/Puri12/opencode-discord-presence/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Puri12/opencode-discord-presence/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Puri12/opencode-discord-presence/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Puri12/opencode-discord-presence/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/Puri12/opencode-discord-presence/releases/tag/v0.1.0
