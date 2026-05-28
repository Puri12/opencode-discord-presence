import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./config.js"
import { DiscordRPCService } from "./services/discord-rpc.js"
import { InstanceCoordinator } from "./services/instance-coordinator.js"
import { PresenceOrchestrator } from "./services/presence-orchestrator.js"
import { SessionTracker } from "./services/session-tracker.js"
import {
  createInitialPresenceState,
  type PresenceSnapshot,
  presenceReducer,
  updateFileAction,
  updateIdentity,
  updateIdle,
  updateRecapCache,
  updateTodoSummary,
} from "./state/presence-state.js"
import type { DiscordPresenceOptions, RichPresenceOptions } from "./types/index.js"
import {
  createSessionMetricsState,
  createSessionRecap,
  normalizeFileIdentity,
  recordFileTouch,
  recordMessageActivity,
  recordTaskContext,
  type SessionMetricsState,
} from "./utils/session-metrics.js"
import {
  clearSessionMetrics,
  loadSessionMetrics,
  pruneStaleSessionMetrics,
  saveSessionMetrics,
} from "./utils/session-persistence.js"
import { getToolLabel } from "./utils/tool-label.js"

async function loadConfigFile(directory: string): Promise<DiscordPresenceOptions | undefined> {
  const paths = [
    join(directory, ".discord-presence.json"),
    join(homedir(), ".discord-presence.json"),
  ]

  for (const configPath of paths) {
    try {
      const content = await readFile(configPath, "utf-8")
      return JSON.parse(content) as DiscordPresenceOptions
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      console.warn("[discord-presence] Failed to load config file:", error)
    }
  }
  return undefined
}

interface ToolExecuteInput {
  tool: string
  sessionID: string
  callID: string
}

interface ToolExecuteOutput {
  args?: unknown
  title?: string
  output?: string
  metadata?: Record<string, unknown>
}

type CallIDContext = Map<
  string,
  {
    filePath?: string
    operation: string
  }
>

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recursive traversal of unknown arg shape needed
function extractFilePathFromArgs(args?: unknown): string | undefined {
  if (!args) return undefined
  if (typeof args === "string") {
    const trimmed = args.trim()
    const quotedWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'")
    const quotedWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"')
    const wasQuoted = quotedWithSingle || quotedWithDouble
    const candidate = wasQuoted ? trimmed.slice(1, -1).trim() : trimmed

    if (!candidate || candidate.startsWith("-")) {
      return undefined
    }

    if (!(candidate.includes("/") || candidate.includes("\\"))) {
      return undefined
    }

    if (!wasQuoted && /\s/.test(candidate)) {
      return undefined
    }

    if (candidate.includes(" ")) {
      return undefined
    }

    return normalizeFileIdentity(candidate)
  }
  if (Array.isArray(args)) {
    for (const item of args) {
      const extracted = extractFilePathFromArgs(item)
      if (extracted) return extracted
    }
  }
  if (typeof args === "object") {
    for (const value of Object.values(args)) {
      const extracted = extractFilePathFromArgs(value)
      if (extracted) return extracted
    }
  }
  return undefined
}

function countRotatingCards(
  opts: RichPresenceOptions,
  hasWarnings: boolean,
  errors: number,
): number {
  let count = 0
  if (opts.enableFileSpotlight) count++
  if (opts.enableMissionBoard) count++
  if (hasWarnings && errors === 0) count++
  count++ // session-stats always present as ultimate fallback
  return Math.max(count, 1)
}

function sanitizeForFilename(raw: string, fallback: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_")
  return sanitized || fallback
}

/**
 * Builds the per-machine, per-Discord-app instance election directory.
 * Hostname segregation keeps shared-HOME setups (NFS, SMB, Dropbox) from
 * making one machine's CLIs suppress another's. ClientId segregation keeps
 * users running multiple Discord application IDs from cross-contaminating.
 */
export function buildInstancesDir(home: string, host: string, clientId: string): string {
  const safeHost = sanitizeForFilename(host, "unknown-host")
  const safeClient = sanitizeForFilename(clientId, "default")
  return join(home, ".opencode-discord-presence", "instances", safeHost, safeClient)
}

/**
 * Settle delay between gaining ownership and calling `rpc.connect()`. Must
 * exceed the coordinator's tick interval (default 1000ms in instance-coordinator)
 * so the previous owner has had at least one tick to discover its ownership
 * loss and run its `rpc.clear()` + `rpc.disconnect()` before the new owner
 * contends for Discord's IPC socket. Without this slack, a fast handoff
 * leaves a brief window where A.clear() can erase B's freshly-pushed presence.
 */
const DEFAULT_OWNER_SETTLE_MS = 1200

export interface OwnershipHandlerOptions {
  rpc: Pick<DiscordRPCService, "connect" | "disconnect" | "clear">
  pushPresence: () => Promise<void>
  startRotationTimer: () => void
  stopRotationTimer: () => void
  isStillOwner: () => boolean
  settleMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface OwnershipHandler {
  onOwnership: (isOwner: boolean) => void
  cancelPending: () => void
}

/**
 * Builds an ownership-change handler with a settle delay before connecting.
 * Gaining ownership schedules a connect after `settleMs`; losing it cancels
 * the pending connect and disconnects immediately. The settle window lets
 * the previous owner finish its disconnect before the new owner contends
 * for Discord's single IPC socket — without it, rapid ownership flips during
 * concurrent CLI startup cause connect/disconnect churn and IPC throttling.
 */
export function createOwnershipHandler(opts: OwnershipHandlerOptions): OwnershipHandler {
  const settleMs = opts.settleMs ?? DEFAULT_OWNER_SETTLE_MS
  const setT = opts.setTimeoutImpl ?? setTimeout
  const clearT = opts.clearTimeoutImpl ?? clearTimeout
  let pending: ReturnType<typeof setTimeout> | null = null

  const cancelPending = () => {
    if (pending) {
      clearT(pending)
      pending = null
    }
  }

  const onOwnership = (isOwner: boolean): void => {
    cancelPending()
    if (isOwner) {
      pending = setT(() => {
        pending = null
        if (!opts.isStillOwner()) return
        opts.startRotationTimer()
        void opts.pushPresence()
        opts.rpc.connect().catch(() => {})
      }, settleMs)
      pending?.unref?.()
    } else {
      opts.stopRotationTimer()
      void opts.rpc.clear()
      void opts.rpc.disconnect()
    }
  }

  return { onOwnership, cancelPending }
}

const DEFAULT_RECAP_DELAY_MS = 30_000

export interface RecapSchedulerOptions {
  clearRecapState: () => void
  delayMs?: number
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

export interface RecapScheduler {
  schedule: () => void
  flushNow: () => void
  cancel: () => void
}

/**
 * Owns the lifecycle of the post-session recap card. The recap is purely a
 * visual state on the snapshot — the RPC lifecycle stays tied to ownership,
 * not the recap. After `delayMs`, the recap state is cleared so rotation no
 * longer surfaces the recap card. `flushNow()` clears immediately (used by
 * any user activity that should resume normal presence); `cancel()` drops
 * the pending clear without running it (used on dispose).
 */
export function createRecapScheduler(opts: RecapSchedulerOptions): RecapScheduler {
  const setT = opts.setTimeoutImpl ?? setTimeout
  const clearT = opts.clearTimeoutImpl ?? clearTimeout
  const delayMs = opts.delayMs ?? DEFAULT_RECAP_DELAY_MS

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false

  const runOnce = (): void => {
    if (!pending) return
    pending = false
    opts.clearRecapState()
  }

  const schedule = (): void => {
    if (timer) clearT(timer)
    pending = true
    timer = setT(() => {
      timer = null
      runOnce()
    }, delayMs)
    timer?.unref?.()
  }

  const flushNow = (): void => {
    if (timer) {
      clearT(timer)
      timer = null
    }
    runOnce()
  }

  const cancel = (): void => {
    if (timer) {
      clearT(timer)
      timer = null
    }
    pending = false
  }

  return { schedule, flushNow, cancel }
}

/**
 * Kicks off plugin runtime side-effects WITHOUT blocking on the initial
 * Discord connection. OpenCode awaits the plugin init promise during
 * bootstrap, so the IPC timeout (~10s when Discord is closed) used to
 * stall the entire UI. We:
 *   1) early-return when this instance is not the owner (rotation +
 *      presence are no-ops anyway, and we don't want a stray timer
 *      keeping the event loop alive),
 *   2) start the rotation timer for the owner,
 *   3) queue initial presence locally and fire `connect()` fire-and-forget.
 */
export function startPluginAsync(
  rpc: Pick<DiscordRPCService, "isConnected" | "connect">,
  pushPresence: () => Promise<void>,
  startRotationTimer: () => void,
  isOwner: () => boolean = () => true,
): void {
  if (!isOwner()) return
  startRotationTimer()
  void pushPresence()
  if (!rpc.isConnected()) {
    rpc.connect().catch(() => {})
  }
}

let primaryPluginActive = false

export function isPrimaryPluginInstance(): boolean {
  if (primaryPluginActive) return false
  primaryPluginActive = true
  return true
}

export function releasePrimaryPluginInstance(): void {
  primaryPluginActive = false
}

export const OpenCodeDiscordPresence: Plugin = async (ctx) => {
  const fileOptions = await loadConfigFile(ctx.directory)
  const config = getConfig(fileOptions)
  if (!config.enabled) return {}

  if (!isPrimaryPluginInstance()) return {}

  const instanceId = randomUUID()

  let rpc: DiscordRPCService | null = new DiscordRPCService(config.clientId, {
    debug: config.debug,
  })
  let snapshot = createInitialPresenceState()

  const orchestrator = new PresenceOrchestrator()

  const tracker = new SessionTracker(ctx.client)
  const mainAgentOnly = config.richPresence.mainAgentOnly

  const callContext: CallIDContext = new Map()

  let sessionMetricsState: SessionMetricsState = createSessionMetricsState()
  const persisted = await loadSessionMetrics(undefined, { instanceId })
  if (persisted) {
    sessionMetricsState = persisted
  }

  void pruneStaleSessionMetrics(undefined, { keepInstanceId: instanceId })

  let rotationIndex = 0
  let rotationTimer: ReturnType<typeof setInterval> | null = null
  let activeRecapScheduler: RecapScheduler | null = null

  const exitRecapIfNeeded = (): void => {
    if (!activeRecapScheduler) return
    activeRecapScheduler.flushNow()
    activeRecapScheduler = null
  }

  const cancelPendingRecap = (): void => {
    if (!activeRecapScheduler) return
    activeRecapScheduler.cancel()
    activeRecapScheduler = null
  }

  const shouldSkipSession = async (sessionID: string | undefined): Promise<boolean> => {
    if (!mainAgentOnly || !sessionID) return false
    const peeked = tracker.peek(sessionID)
    if (peeked === "main") return false
    if (peeked === "sub") return true
    const resolved = await tracker.resolve(sessionID)
    return resolved === "sub"
  }

  const shouldSkipSessionSync = (sessionID: string | undefined): boolean => {
    if (!mainAgentOnly || !sessionID) return false
    const peeked = tracker.peek(sessionID)
    if (peeked === "sub") return true
    if (peeked === "unknown") {
      void tracker.resolve(sessionID)
    }
    return false
  }

  const coordinator = new InstanceCoordinator({
    instancesDir: buildInstancesDir(homedir(), hostname(), config.clientId),
    instanceId,
  })

  const pushPresence = async () => {
    if (!rpc) return
    if (!coordinator.isOwner()) return
    const snapshotWithMetrics: PresenceSnapshot = {
      ...snapshot,
      sessionMetrics: sessionMetricsState,
    }
    const hasWarnings = snapshot.diagnosticsSummary.warnings > 0
    const errors = snapshot.diagnosticsSummary.errors
    const cardCount = countRotatingCards(config.richPresence, hasWarnings, errors)
    rotationIndex = rotationIndex % cardCount
    await rpc.setPresenceFromSnapshot(
      snapshotWithMetrics,
      config.richPresence,
      rotationIndex,
      config.language,
    )
  }

  const startRotationTimer = () => {
    if (rotationTimer) clearInterval(rotationTimer)
    const intervalMs = config.richPresence.rotationIntervalSeconds * 1000
    rotationTimer = setInterval(async () => {
      rotationIndex =
        (rotationIndex + 1) %
        countRotatingCards(
          config.richPresence,
          snapshot.diagnosticsSummary.warnings > 0,
          snapshot.diagnosticsSummary.errors,
        )
      await pushPresence()
    }, intervalMs)
    rotationTimer?.unref?.()
  }

  const stopRotationTimer = () => {
    if (rotationTimer) {
      clearInterval(rotationTimer)
      rotationTimer = null
    }
  }

  const exitIdleIfNeeded = async () => {
    if (snapshot.idle) {
      snapshot = presenceReducer(snapshot, updateIdle(false))
    }
  }

  const ownershipHandler = createOwnershipHandler({
    rpc: {
      connect: () => rpc?.connect() ?? Promise.resolve(false),
      disconnect: () => rpc?.disconnect() ?? Promise.resolve(),
      clear: () => rpc?.clear() ?? Promise.resolve(),
    },
    pushPresence,
    startRotationTimer,
    stopRotationTimer,
    isStillOwner: () => coordinator.isOwner(),
  })

  coordinator.onOwnershipChange((isOwner) => {
    if (!isOwner) cancelPendingRecap()
    ownershipHandler.onOwnership(isOwner)
  })
  coordinator.start()

  if (coordinator.isOwner()) {
    ownershipHandler.onOwnership(true)
  }

  /**
   * Full graceful teardown — invoked by the plugin's `dispose` hook AND by
   * `SIGINT` / `SIGTERM` fallbacks so any exit path (opencode shutdown,
   * user `Ctrl+C`, or process kill via signal) releases the primary-plugin
   * guard, cancels pending settle/recap timers, unlinks the coordinator
   * heartbeat file, stops the rotation timer, and clears+disconnects the
   * Discord RPC. Without the signal path, SIGTERM would leave the
   * coordinator file on disk and the Discord activity stale.
   */
  const shutdown = async () => {
    releasePrimaryPluginInstance()
    ownershipHandler.cancelPending()
    cancelPendingRecap()
    coordinator.stop()
    stopRotationTimer()
    if (!rpc) return
    const current = rpc
    rpc = null
    await current.clear()
    await current.disconnect()
  }

  process.on("SIGINT", () => {
    void shutdown()
  })
  process.on("SIGTERM", () => {
    void shutdown()
  })

  return {
    dispose: () => shutdown(),
    "chat.message": async (input, _output) => {
      const sessionID = (input as { sessionID?: string }).sessionID ?? ""
      if (await shouldSkipSession(sessionID)) return

      coordinator.recordActivity({ flush: true })
      exitRecapIfNeeded()

      const agent = input.agent ?? snapshot.identity.agent
      const model = input.model?.modelID ?? snapshot.identity.model

      const { wasIdle } = orchestrator.markBusy(sessionID, agent, model)
      if (wasIdle) rpc?.resetSessionStart()

      snapshot = presenceReducer(
        snapshot,
        updateIdentity({
          agent,
          model,
        }),
      )

      sessionMetricsState = recordMessageActivity(sessionMetricsState)
      await saveSessionMetrics(sessionMetricsState, undefined, { instanceId })

      await exitIdleIfNeeded()

      await pushPresence()
    },

    "tool.execute.before": async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
      if (shouldSkipSessionSync(input.sessionID)) return

      const toolName = input.tool ?? ""
      const callID = input.callID ?? ""
      const filePath = extractFilePathFromArgs(output.args)
      const command = typeof output.args === "string" ? output.args : undefined
      const operation = getToolLabel({ toolName, command })

      if (callID) {
        callContext.set(callID, { filePath, operation })
      }

      if (filePath) {
        snapshot = presenceReducer(
          snapshot,
          updateFileAction({ file: filePath, action: toolName, operation }),
        )
        sessionMetricsState = recordFileTouch(sessionMetricsState, filePath)
        await saveSessionMetrics(sessionMetricsState, undefined, { instanceId })
      } else {
        snapshot = presenceReducer(snapshot, updateFileAction({ action: toolName, operation }))
      }

      await exitIdleIfNeeded()
      await pushPresence()
    },

    "tool.execute.after": async (input: ToolExecuteInput, _output: ToolExecuteOutput) => {
      if (shouldSkipSessionSync(input.sessionID)) return

      const toolName = input.tool ?? ""
      const callID = input.callID ?? ""

      const captured = callContext.get(callID)
      const filePath = captured?.filePath
      const operation = captured?.operation ?? getToolLabel({ toolName })

      if (callID) {
        callContext.delete(callID)
      }

      if (filePath) {
        snapshot = presenceReducer(
          snapshot,
          updateFileAction({ file: filePath, action: toolName, operation }),
        )
        sessionMetricsState = recordFileTouch(sessionMetricsState, filePath)
        await saveSessionMetrics(sessionMetricsState, undefined, { instanceId })
      } else {
        snapshot = presenceReducer(snapshot, updateFileAction({ action: toolName, operation }))
      }

      await exitIdleIfNeeded()
      await pushPresence()
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event dispatch pattern requires all branches
    event: async ({ event }) => {
      const eventType = event.type

      if (eventType === "session.created" || eventType === "session.updated") {
        const info = (event.properties as { info?: { id?: string; parentID?: string | null } })
          ?.info
        if (info?.id) {
          tracker.prime(info.id, info.parentID ?? undefined)
        }
        return
      }

      if (eventType === "session.status") {
        const props = event.properties as {
          sessionID?: string
          status?: { type?: string }
        }
        const sessionID = props.sessionID ?? ""
        if (await shouldSkipSession(sessionID)) return
        const statusType = props.status?.type
        if (statusType === "idle") {
          const { nowAllIdle, lastAgent } = orchestrator.markIdle(sessionID)
          if (nowAllIdle) {
            snapshot = presenceReducer(
              snapshot,
              updateIdentity({ agent: lastAgent || snapshot.identity.agent }),
            )
            snapshot = presenceReducer(snapshot, updateIdle(true))
            await pushPresence()
          }
        } else if (statusType === "busy") {
          const { wasIdle } = orchestrator.markBusy(sessionID)
          if (wasIdle) rpc?.resetSessionStart()
          await exitIdleIfNeeded()
          await pushPresence()
        }
        return
      }

      if (eventType === "file.edited") {
        const filePath = (event.properties as { file?: string } | undefined)?.file
        if (filePath) {
          const normalized = normalizeFileIdentity(filePath)
          snapshot = presenceReducer(
            snapshot,
            updateFileAction({
              file: normalized,
              action: "edit",
              operation: "Editing",
            }),
          )
          sessionMetricsState = recordFileTouch(sessionMetricsState, normalized)
          await saveSessionMetrics(sessionMetricsState, undefined, { instanceId })
        }
        await exitIdleIfNeeded()
        await pushPresence()
        return
      }

      if (eventType === "todo.updated") {
        const props = event.properties as
          | {
              todos?: Array<{
                content?: string
                status?: string
                priority?: string
              }>
              sessionID?: string
            }
          | undefined
        const todos = props?.todos

        if (Array.isArray(todos)) {
          const total = todos.length
          const completed = todos.filter((t) => t.status === "completed").length
          const pending = total - completed
          const allDone = completed === total && total > 0

          const activeTodo =
            todos.find((t) => t.status === "in_progress") ??
            todos.find((t) => t.status === "pending")
          const activeTaskLabel = activeTodo?.content

          snapshot = presenceReducer(
            snapshot,
            updateTodoSummary({
              total,
              completed,
              pending,
              allDone,
              activeTaskLabel,
            }),
          )

          if (activeTaskLabel) {
            sessionMetricsState = recordTaskContext(sessionMetricsState, activeTaskLabel)
            await saveSessionMetrics(sessionMetricsState, undefined, { instanceId })
          }
        }

        await exitIdleIfNeeded()
        await pushPresence()
        return
      }

      if (eventType === "lsp.client.diagnostics") {
        ctx.client.app.log({
          body: {
            service: "discord-presence",
            level: "info",
            message: `lsp.client.diagnostics received for ${(event.properties as { path?: string } | undefined)?.path} — diagnostic counts unavailable in v1 plugin API`,
          },
        })
        return
      }

      if (eventType === "session.idle") {
        const sessionID = (event.properties as { sessionID?: string }).sessionID ?? ""
        if (await shouldSkipSession(sessionID)) return
        const { nowAllIdle, lastAgent } = orchestrator.markIdle(sessionID)
        if (nowAllIdle) {
          if (lastAgent) {
            snapshot = presenceReducer(snapshot, updateIdentity({ agent: lastAgent }))
          }
          snapshot = presenceReducer(snapshot, updateIdle(true))
          await pushPresence()
        }
        return
      }

      if (eventType === "session.deleted") {
        const deletedID = (event.properties as { info?: { id?: string } }).info?.id ?? ""
        const wasMainOrTracked = !mainAgentOnly || tracker.peek(deletedID) === "main"
        orchestrator.markIdle(deletedID)
        tracker.forget(deletedID)

        if (!wasMainOrTracked) return

        const recap = createSessionRecap(sessionMetricsState)
        await clearSessionMetrics(undefined, { instanceId })
        snapshot = presenceReducer(
          snapshot,
          updateRecapCache({
            ...recap,
            timestamp: Date.now(),
          }),
        )

        await pushPresence()

        cancelPendingRecap()
        const scheduler = createRecapScheduler({
          clearRecapState: () => {
            snapshot = { ...snapshot, recapCache: {} }
            activeRecapScheduler = null
            void pushPresence()
          },
        })
        activeRecapScheduler = scheduler
        scheduler.schedule()

        return
      }

      ctx.client.app.log({
        body: {
          service: "discord-presence",
          level: "info",
          message: `Unhandled event type: ${eventType}`,
        },
      })
    },
  }
}
