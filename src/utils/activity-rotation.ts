/**
 * Hybrid rotation and precedence selection engine for Discord Rich Presence.
 *
 * Precedence (highest to lowest):
 *  1. session-deleted recap card (recapCache present)
 *  2. diagnostics-error (errors > 0)
 *  3. idle
 *  4. all-tasks-complete (allDone && total > 0)
 *  5. active-operation + file spotlight (rotating informational)
 *  6. task mission board (rotating informational)
 *  7. diagnostics-warnings (rotating informational, warnings > 0, errors = 0)
 *  8. session stats (rotating informational)
 *  9. fallback: agent-centric headline only
 *
 * Critical states pin. Informational states rotate on a configurable interval.
 */

import type { PresenceSnapshot } from "../state/presence-state"
import type { Language, RichPresenceOptions } from "../types/index.js"
import { getFileIconKey } from "./file-icons.js"
import { formatFileLabel } from "./file-label.js"
import { getObjectParticle, getTopicParticle } from "./particle.js"
import { getToolLabel, type ToolLabelInput } from "./tool-label.js"

const MAX_STATE_LENGTH = 42

/** Time period (ms) after which a recap is considered stale. */
const RECAP_STALE_MS = 30_000

function formatStatsLine(
  metrics: PresenceSnapshot["sessionMetrics"],
  language: Language,
  model?: string,
): string {
  const prompts = metrics.messageCount
  const files = metrics.uniqueFilesTouched?.size ?? 0
  const modelPrefix = model ? `${model} • ` : ""

  if (language === "ko") {
    return `${modelPrefix}${prompts}개 프롬프트 • ${files}개 파일`
  }

  return `${modelPrefix}${prompts} prompts • ${files} files`
}

function formatIdleContext(
  todoSummary: PresenceSnapshot["todoSummary"],
  fileAction: PresenceSnapshot["fileAction"],
  language: Language,
): string | undefined {
  if (todoSummary.activeTaskLabel) {
    const label = truncateTaskLabel(todoSummary.activeTaskLabel, MAX_STATE_LENGTH)
    return language === "ko" ? `마지막 작업: ${label}` : `Last task: ${label}`
  }

  if (fileAction.file) {
    const label = formatFileLabel(fileAction.file)
    return language === "ko" ? `마지막 파일: ${label}` : `Last file: ${label}`
  }

  return undefined
}

function formatDiagnosticsState(errors: number, warnings: number, language: Language): string {
  if (language === "ko") {
    return `오류 ${errors}개, 경고 ${warnings}개`
  }

  return `${errors} error${errors !== 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}`
}

function formatWarningsState(warnings: number, language: Language): string {
  if (language === "ko") {
    return `경고 ${warnings}개`
  }

  return `${warnings} warning${warnings !== 1 ? "s" : ""}`
}

function formatTaskLine(todo: PresenceSnapshot["todoSummary"]): string {
  if (!todo || todo.total === 0) return ""
  const label = todo.activeTaskLabel
    ? truncateTaskLabel(todo.activeTaskLabel, MAX_STATE_LENGTH)
    : ""
  return `${label ? `${label} ` : ""}(${todo.completed}/${todo.total})`
}

function truncateTaskLabel(label: string, maxLength: number): string {
  if (label.length <= maxLength) return label
  return `${label.slice(0, maxLength - 1)}…`
}

/** Which rotating informational card is active given the current index. */
export type RotatingCard =
  | "file-spotlight"
  | "task-mission-board"
  | "diagnostics-warnings"
  | "session-stats"

/**
 * Builds the ordered list of rotating informational cards for the current
 * feature flags and diagnostics state. Single source of truth shared by the
 * renderer (resolveRotatingCard) and the plugin's rotation-index modulus —
 * keeping both derived from one list prevents index/card drift.
 */
export function buildRotatingCards(
  opts: RichPresenceOptions,
  hasWarnings: boolean,
  errors: number,
): RotatingCard[] {
  const cards: RotatingCard[] = []
  if (opts.enableFileSpotlight) cards.push("file-spotlight")
  if (opts.enableMissionBoard) cards.push("task-mission-board")
  // Warnings rotating card only participates when warnings are present and no errors
  if (hasWarnings && errors === 0) cards.push("diagnostics-warnings")
  cards.push("session-stats") // stats are always present as ultimate fallback
  return cards
}

/**
 * Maps a rotation index to a RotatingCard, honouring enabled/disabled features
 * and whether the warnings rotating card is relevant (warnings > 0 && errors = 0).
 * Returns null when all rotating cards are disabled.
 */
export function resolveRotatingCard(
  index: number,
  opts: RichPresenceOptions,
  hasWarnings: boolean,
  errors: number,
): RotatingCard | null {
  const cards = buildRotatingCards(opts, hasWarnings, errors)
  if (cards.length === 0) return null
  return cards[index % cards.length]
}

export interface ActivityPayload {
  details: string
  state?: string
  assets?: {
    largeImageKey?: string
    largeImageText?: string
    smallImageKey?: string
    smallImageText?: string
  }
}

/**
 * Composes a Discord activity payload from a PresenceSnapshot.
 * Implements the locked precedence matrix and hybrid rotation policy.
 *
 * @param snapshot       - Current presence state
 * @param opts          - Rich presence feature flags and rotation interval
 * @param rotationIndex - Which informational card to show (0-based). Caller
 *                        should increment on each rotation tick.
 * @param language      - Display language for localized presence strings
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: precedence dispatch inherently complex
export function getActivity(
  snapshot: PresenceSnapshot,
  opts: RichPresenceOptions,
  rotationIndex = 0,
  language: Language = "en",
): ActivityPayload {
  const {
    identity,
    idle,
    fileAction,
    todoSummary,
    diagnosticsSummary,
    sessionMetrics,
    recapCache,
  } = snapshot

  const agent = identity.agent ?? "OpenCode"
  const model = identity.model
  const { errors, warnings } = diagnosticsSummary

  const withModel = (line: string | undefined): string | undefined => {
    if (!model) return line
    if (!line) return model
    return `${model} • ${line}`
  }

  // ── 1. Session recap ─────────────────────────────────────────────────────
  if (recapCache && recapCache.timestamp != null) {
    const age = Date.now() - recapCache.timestamp
    if (age < RECAP_STALE_MS) {
      return {
        details: language === "ko" ? "세션 완료!" : "Session Complete!",
        state: formatStatsLine(
          {
            ...sessionMetrics,
            messageCount: recapCache.messageCount ?? sessionMetrics.messageCount,
            uniqueFilesTouched: new Set(recapCache.filesTouched ?? []),
            activeDurationSeconds:
              recapCache.activeDurationSeconds ?? sessionMetrics.activeDurationSeconds,
          },
          language,
        ),
        assets: {
          largeImageKey: "state-recap",
          largeImageText: "Session Recap",
        },
      }
    }
  }

  // ── 2. Diagnostics-error ────────────────────────────────────────────────
  if (opts.diagnostics.errorsOnly && errors > 0) {
    return {
      details:
        language === "ko" ? `${agent}${getObjectParticle(agent)} 작업중` : `Working with ${agent}`,
      state: withModel(formatDiagnosticsState(errors, warnings, language)),
      assets: {
        largeImageKey: "state-error",
        largeImageText: "Diagnostics",
      },
    }
  }

  // ── 3. Idle ─────────────────────────────────────────────────────────────
  if (idle) {
    const idleContext = formatIdleContext(todoSummary, fileAction, language)

    const details =
      language === "ko" ? `${agent}${getTopicParticle(agent)} 휴식중` : `${agent} is idle`

    return {
      details,
      state: idleContext,
      assets: {
        largeImageKey: "state-idle",
        largeImageText: "Idle",
      },
    }
  }

  // ── 4. All tasks complete ───────────────────────────────────────────────
  if (todoSummary.allDone && todoSummary.total > 0) {
    const doneLine =
      language === "ko"
        ? `${todoSummary.completed}/${todoSummary.total} 완료`
        : `${todoSummary.completed}/${todoSummary.total} finished`
    return {
      details: language === "ko" ? "모든 작업 완료!" : "All tasks complete!",
      state: withModel(doneLine),
      assets: {
        largeImageKey: "state-complete",
        largeImageText: "All Done",
      },
    }
  }

  // ── 5–8. Rotating informational cards ─────────────────────────────────
  const rotatingCard = resolveRotatingCard(rotationIndex, opts, warnings > 0, errors)

  // ── 5. File spotlight ────────────────────────────────────────────────────
  if (rotatingCard === "file-spotlight" && fileAction?.file) {
    // Derive operation label using the existing tool-label utility
    const toolInput: ToolLabelInput = {
      eventName: fileAction.action ? `tool.execute.${fileAction.action}` : undefined,
      toolName: fileAction.action,
    }
    const operation = fileAction.operation ?? getToolLabel(toolInput)
    const fileLabel = formatFileLabel(fileAction.file)

    const details =
      language === "ko" ? `${agent}${getObjectParticle(agent)} 작업중` : `Working with ${agent}`

    return {
      details,
      state: withModel(fileLabel),
      assets: {
        // Use the existing file-icons utility for language-based icons
        largeImageKey: getFileIconKey(fileAction.file, fileAction.language),
        largeImageText: operation,
      },
    }
  }

  // ── 6. Task mission board ────────────────────────────────────────────────
  if (rotatingCard === "task-mission-board" && todoSummary.total > 0) {
    const details =
      language === "ko" ? `${agent}${getObjectParticle(agent)} 작업중` : `Working with ${agent}`
    return {
      details,
      state: withModel(formatTaskLine(todoSummary)),
      assets: {
        largeImageKey: "task",
        largeImageText: "Mission Board",
      },
    }
  }

  // ── 7. Diagnostics-warnings (rotating informational) ───────────────────
  // Only shown when warnings > 0 and errors = 0 (otherwise step 2 pins)
  if (rotatingCard === "diagnostics-warnings" && warnings > 0 && errors === 0) {
    const details =
      language === "ko" ? `${agent}${getObjectParticle(agent)} 작업중` : `Working with ${agent}`
    return {
      details,
      state: withModel(formatWarningsState(warnings, language)),
      assets: {
        largeImageKey: "state-warn",
        largeImageText: "Warnings",
      },
    }
  }

  // ── 8. Session stats (always available fallback) ─────────────────────────
  const fallbackDetails =
    language === "ko" ? `${agent}${getObjectParticle(agent)} 작업중` : `Working with ${agent}`
  return {
    details: fallbackDetails,
    state: formatStatsLine(sessionMetrics, language, model),
    assets: {
      largeImageKey: "stats",
      largeImageText: model ? `Session Stats — ${model}` : "Session Stats",
    },
  }
}
