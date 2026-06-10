import { randomUUID } from "node:crypto"
import { homedir, hostname } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./config.js"
import { loadConfigFile } from "./config-loader.js"
import { buildInstancesDir, createOwnershipHandler } from "./lifecycle/ownership-handler.js"
import { createRecapScheduler, type RecapScheduler } from "./lifecycle/recap-scheduler.js"
import { createRotationTicker } from "./lifecycle/rotation-ticker.js"
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
import type { RichPresenceOptions } from "./types/index.js"
import { buildRotatingCards } from "./utils/activity-rotation.js"
import { extractFilePathFromArgs } from "./utils/arg-paths.js"
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

/** Card count derived from the renderer's own card list — no drift possible. */
function countRotatingCards(
  opts: RichPresenceOptions,
  hasWarnings: boolean,
  errors: number,
): number {
  return Math.max(buildRotatingCards(opts, hasWarnings, errors).length, 1)
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
  const { options: fileOptions, parseError } = await loadConfigFile(ctx.directory)
  const config = getConfig(fileOptions)
  if (parseError && config.debug) {
    console.warn(`[discord-presence] failed to parse ${parseError.path}`, parseError.error)
  }
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
  let shutdownStarted = false

  const warnDebug = (scope: string, error: unknown): void => {
    if (!config.debug) return
    console.warn(`[discord-presence] ${scope} failed`, error)
  }

  const guard = <Args extends unknown[]>(
    scope: string,
    fn: (...args: Args) => Promise<void>,
  ): ((...args: Args) => Promise<void>) => {
    return async (...args: Args): Promise<void> => {
      try {
        await fn(...args)
      } catch (error) {
        warnDebug(scope, error)
      }
    }
  }

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
    const ticker = createRotationTicker({
      getRotationIndex: () => rotationIndex,
      setRotationIndex: (index) => {
        rotationIndex = index
      },
      countCards: () =>
        countRotatingCards(
          config.richPresence,
          snapshot.diagnosticsSummary.warnings > 0,
          snapshot.diagnosticsSummary.errors,
        ),
      pushPresence,
      onError: (error) => warnDebug("rotation timer", error),
    })
    rotationTimer = setInterval(() => {
      void ticker.tick()
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
    if (shutdownStarted) return
    shutdownStarted = true
    process.off("SIGINT", handleSigint)
    process.off("SIGTERM", handleSigterm)
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

  const handleSigint = () => {
    void shutdown().catch((error) => warnDebug("shutdown", error))
  }
  const handleSigterm = () => {
    void shutdown().catch((error) => warnDebug("shutdown", error))
  }

  process.on("SIGINT", handleSigint)
  process.on("SIGTERM", handleSigterm)

  return {
    dispose: () => shutdown(),
    "chat.message": guard("chat.message", async (input, _output) => {
      const sessionID = (input as { sessionID?: string }).sessionID ?? ""
      if (await shouldSkipSession(sessionID)) return

      coordinator.recordActivity({ flush: true })

      // Self-heal: if we are owner but the RPC has fallen out of `connected`
      // (transient Discord IPC failure exhausted MAX_RETRIES so
      // scheduleReconnect bailed) treat user activity as the signal to try
      // again. connect() internally resets retryCount when previously at the
      // cap, so this gets a fresh budget without bypassing the retry limit
      // for the ongoing failure cycle.
      if (rpc && coordinator.isOwner() && !rpc.isConnected()) {
        rpc.connect().catch(() => {})
      }

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
    }),

    "tool.execute.before": guard(
      "tool.execute.before",
      async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
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
    ),

    "tool.execute.after": guard(
      "tool.execute.after",
      async (input: ToolExecuteInput, _output: ToolExecuteOutput) => {
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
    ),

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event dispatch pattern requires all branches
    event: guard("event", async ({ event }) => {
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
    }),
  }
}
