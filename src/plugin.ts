import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./config.js"
import { createRecapCleanupTask, DiscordRPCService } from "./services/discord-rpc.js"
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

/**
 * Captured context from tool.execute.before, keyed by callID for after-hook retrieval.
 * This is the ONLY contract-safe source of executable args for the after-hook.
 */
type CallIDContext = Map<
  string,
  {
    filePath?: string
    operation: string
  }
>

/**
 * Extracts a normalized file path from tool execute args if it looks like a file path.
 */
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

/**
 * Counts how many rotating informational cards are active given the current options.
 */
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

export const OpenCodeDiscordPresence: Plugin = async (ctx) => {
  const fileOptions = await loadConfigFile(ctx.directory)
  const config = getConfig(fileOptions)
  if (!config.enabled) return {}

  // Instance-scoped RPC service and presence state.
  let rpc: DiscordRPCService | null = new DiscordRPCService(config.clientId, {
    debug: config.debug,
  })
  let snapshot = createInitialPresenceState()

  // Multi-agent state machine: tracks busy/idle across all chat.message sessions
  // so idle text appears only when every tracked session reports idle.
  const orchestrator = new PresenceOrchestrator()

  // Session kind tracker (main vs sub-agent). Only consulted when mainAgentOnly
  // is enabled — primed via session.created / session.updated events for sync
  // peek(), with async resolve() fallback through the OpenCode SDK.
  const tracker = new SessionTracker(ctx.client)
  const mainAgentOnly = config.richPresence.mainAgentOnly

  // Contract-safe before/after hook state: callID-scoped context captured in before, retrieved in after.
  // This is the ONLY safe way to pass executable args from before→after since after.output lacks args.
  const callContext: CallIDContext = new Map()

  // Session metrics tracked separately due to Set serialization in SessionMetrics
  let sessionMetricsState: SessionMetricsState = createSessionMetricsState()
  // Try to restore session metrics from previous session (e.g., after crash or restart)
  const persisted = await loadSessionMetrics()
  if (persisted) {
    sessionMetricsState = persisted
  }

  // Rotation state
  let rotationIndex = 0
  let rotationTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Returns true if a sessionID is a sub-agent that should be skipped under
   * mainAgentOnly. Uses cached peek first; if unknown, async-resolves via SDK.
   * When mainAgentOnly is disabled, always returns false (process everything).
   */
  const shouldSkipSession = async (sessionID: string | undefined): Promise<boolean> => {
    if (!mainAgentOnly || !sessionID) return false
    const peeked = tracker.peek(sessionID)
    if (peeked === "main") return false
    if (peeked === "sub") return true
    const resolved = await tracker.resolve(sessionID)
    return resolved === "sub"
  }

  /**
   * Synchronous fast-path skip check used in high-frequency tool hooks. When
   * the session is "unknown" we kick off an async resolve and let THIS event
   * through so we do not block file-spotlight updates on SDK latency.
   */
  const shouldSkipSessionSync = (sessionID: string | undefined): boolean => {
    if (!mainAgentOnly || !sessionID) return false
    const peeked = tracker.peek(sessionID)
    if (peeked === "sub") return true
    if (peeked === "unknown") {
      void tracker.resolve(sessionID)
    }
    return false
  }

  /**
   * Pushes the current snapshot + live metrics to Discord via the rotation engine.
   */
  const pushPresence = async () => {
    if (!rpc) return
    // Derive sessionMetrics from live metrics state for every Discord push
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

  /**
   * Starts the rotation timer for informational cards.
   */
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
  }

  /**
   * Stops the rotation timer.
   */
  const stopRotationTimer = () => {
    if (rotationTimer) {
      clearInterval(rotationTimer)
      rotationTimer = null
    }
  }

  /**
   * Exits idle mode if currently idle — called on any active event.
   */
  const exitIdleIfNeeded = async () => {
    if (snapshot.idle) {
      snapshot = presenceReducer(snapshot, updateIdle(false))
    }
  }

  const connected = rpc.isConnected() || (await rpc.connect())
  if (connected) {
    await pushPresence()
    startRotationTimer()
  }

  return {
    // ── chat.message ────────────────────────────────────────────────────────────
    "chat.message": async (input, _output) => {
      const sessionID = (input as { sessionID?: string }).sessionID ?? ""
      if (await shouldSkipSession(sessionID)) return

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
      await saveSessionMetrics(sessionMetricsState)

      await exitIdleIfNeeded()

      await pushPresence()
    },

    // ── tool.execute.before ───────────────────────────────────────────────────
    "tool.execute.before": async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
      if (shouldSkipSessionSync(input.sessionID)) return

      const toolName = input.tool ?? ""
      const callID = input.callID ?? ""
      const filePath = extractFilePathFromArgs(output.args)
      // Infer operation label with command context from args for bash commands
      const command = typeof output.args === "string" ? output.args : undefined
      const operation = getToolLabel({ toolName, command })

      // Capture context for after-hook retrieval via callID (contract-safe args path)
      if (callID) {
        callContext.set(callID, { filePath, operation })
      }

      if (filePath) {
        snapshot = presenceReducer(
          snapshot,
          updateFileAction({ file: filePath, action: toolName, operation }),
        )
        sessionMetricsState = recordFileTouch(sessionMetricsState, filePath)
        await saveSessionMetrics(sessionMetricsState)
      } else {
        snapshot = presenceReducer(snapshot, updateFileAction({ action: toolName, operation }))
      }

      await exitIdleIfNeeded()
      await pushPresence()
    },

    // ── tool.execute.after ────────────────────────────────────────────────────
    // IMPORTANT: output.shape is { title, output, metadata } — NO args field per contract.
    // File context is retrieved from before-hook capture via callID (the ONLY contract-safe path).
    "tool.execute.after": async (input: ToolExecuteInput, _output: ToolExecuteOutput) => {
      if (shouldSkipSessionSync(input.sessionID)) return

      const toolName = input.tool ?? ""
      const callID = input.callID ?? ""

      // Retrieve captured context from before-hook (contract-safe args source)
      const captured = callContext.get(callID)
      const filePath = captured?.filePath
      const operation = captured?.operation ?? getToolLabel({ toolName })

      // Clean up captured context after retrieval to avoid memory leak
      if (callID) {
        callContext.delete(callID)
      }

      if (filePath) {
        snapshot = presenceReducer(
          snapshot,
          updateFileAction({ file: filePath, action: toolName, operation }),
        )
        sessionMetricsState = recordFileTouch(sessionMetricsState, filePath)
        await saveSessionMetrics(sessionMetricsState)
      } else {
        snapshot = presenceReducer(snapshot, updateFileAction({ action: toolName, operation }))
      }

      await exitIdleIfNeeded()
      await pushPresence()
    },

    // ── Generic event hook ────────────────────────────────────────────────────
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: event dispatch pattern requires all branches
    event: async ({ event }) => {
      const eventType = event.type

      // ── session.created / session.updated — prime tracker with parentID ──
      if (eventType === "session.created" || eventType === "session.updated") {
        const info = (event.properties as { info?: { id?: string; parentID?: string | null } })
          ?.info
        if (info?.id) {
          tracker.prime(info.id, info.parentID ?? undefined)
        }
        return
      }

      // ── session.status — busy/idle lifecycle for the orchestrator ────────
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

      // ── file.edited ───────────────────────────────────────────────────────
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
          await saveSessionMetrics(sessionMetricsState)
        }
        await exitIdleIfNeeded()
        await pushPresence()
        return
      }

      // ── todo.updated ──────────────────────────────────────────────────────
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
            await saveSessionMetrics(sessionMetricsState)
          }
        }

        await exitIdleIfNeeded()
        await pushPresence()
        return
      }

      // ── lsp.client.diagnostics ─────────────────────────────────────────────
      if (eventType === "lsp.client.diagnostics") {
        // lsp.client.diagnostics is a notification that diagnostics changed for a path.
        // The OpenCode plugin API does not provide error/warning counts through this event.
        // We cannot implement the diagnostics-error pin in v1 from this event alone.
        ctx.client.app.log({
          body: {
            service: "discord-presence",
            level: "info",
            message: `lsp.client.diagnostics received for ${(event.properties as { path?: string } | undefined)?.path} — diagnostic counts unavailable in v1 plugin API`,
          },
        })
        return
      }

      // ── session.idle ──────────────────────────────────────────────────────
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

      // ── session.deleted ───────────────────────────────────────────────────
      if (eventType === "session.deleted") {
        const deletedID = (event.properties as { info?: { id?: string } }).info?.id ?? ""
        const wasMainOrTracked = !mainAgentOnly || tracker.peek(deletedID) === "main"
        orchestrator.markIdle(deletedID)
        tracker.forget(deletedID)

        // Sub-agent deletions in mainAgentOnly mode never owned presence, so
        // they should not trigger the session recap — that would steal the
        // user's main-session card and tear down RPC mid-conversation.
        if (!wasMainOrTracked) return

        stopRotationTimer()

        // Build recap from accumulated metrics
        const recap = createSessionRecap(sessionMetricsState)
        await clearSessionMetrics()
        snapshot = presenceReducer(
          snapshot,
          updateRecapCache({
            ...recap,
            timestamp: Date.now(),
          }),
        )

        await pushPresence()

        const recapRpc = rpc
        rpc = null
        const clearRecap = () => {
          snapshot = presenceReducer(snapshot, updateRecapCache({}))
        }
        const cleanupRecap = createRecapCleanupTask(recapRpc, clearRecap)

        // After 30 seconds, clear recap state and tear down the specific RPC session
        setTimeout(() => {
          void cleanupRecap()
        }, 30_000)

        return
      }

      // ── Unknown event type (non-crashing fallback) ──────────────────────────
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
