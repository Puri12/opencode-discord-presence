/**
 * Presence state management for Discord Rich Presence.
 * Provides a normalized, instance-scoped PresenceSnapshot model with
 * partial update semantics to avoid wiping unrelated valid state.
 */

/**
 * File action context for runtime states.
 * Provides enough detail for editing/reading/diagnosing without vague summaries.
 */
export interface FileAction {
  file?: string
  action?: "edit" | "view" | "create" | "delete" | "read" | "diagnose" | "rename" | "move" | string
  line?: number
  language?: string
  operation?: string
}

/**
 * Todo item with active task label support.
 * Supports mission board display with explicit all-done detection.
 */
export interface TodoSummary {
  total: number
  completed: number
  pending: number
  allDone: boolean
  activeTaskLabel?: string
}

/**
 * Diagnostics with categorized severity for runtime states.
 */
export interface DiagnosticsSummary {
  errors: number
  warnings: number
  hints: number
  infos?: number
}

/**
 * Session metrics for recap and stats composition.
 */
export interface SessionMetrics {
  messageCount: number
  uniqueFilesTouched: Set<string>
  sessionStartTimestamp: number
  activeDurationSeconds: number
  lastActivityTimestamp: number
  agentSwitches: number
  currentTaskContext?: string
  currentFileContext?: string
  lastTaskContext?: string
  lastFileContext?: string
  tokenUsage?: number
  cost?: number
}

/**
 * Recap composition fields beyond a generic summary string.
 */
export interface RecapCache {
  summary?: string
  timestamp?: number
  filesTouched?: string[]
  uniqueFileCount?: number
  messageCount?: number
  activeDurationSeconds?: number
  lastTaskContext?: string
  lastFileContext?: string
  agentSwitches?: number
  completedTasks?: string[]
  pendingTasks?: string[]
  keyOutcomes?: string[]
}

/**
 * Rotation metadata for agent rotation states.
 */
export interface RotationMetadata {
  index?: number
  total?: number
  strategy?: string
  lastRotationTimestamp?: number
}

/**
 * Agent/model identity with full context.
 */
export interface AgentIdentity {
  agent: string
  model: string
  agentVersion?: string
}

/**
 * Instance-scoped PresenceSnapshot model.
 * Covers all fields required for partial normalized event updates
 * and supports later composition for mission board, recap, and stats.
 */
export interface PresenceSnapshot {
  // Agent/model identity
  identity: AgentIdentity

  // Activity state
  idle: boolean
  fileAction: FileAction

  // Mission board / task state
  todoSummary: TodoSummary

  // Diagnostics state
  diagnosticsSummary: DiagnosticsSummary

  // Session metrics (for recap/stats)
  sessionMetrics: SessionMetrics

  // Recap composition cache
  recapCache: RecapCache

  // Rotation state
  rotationMetadata: RotationMetadata
}

/**
 * Creates an initial empty PresenceSnapshot with sensible defaults.
 * Partial updates via reducer will NOT wipe unrelated valid state.
 */
export function createInitialPresenceState(): PresenceSnapshot {
  return {
    identity: { agent: "OpenCode", model: "" },
    idle: false,
    fileAction: {},
    todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
    sessionMetrics: {
      messageCount: 0,
      uniqueFilesTouched: new Set<string>(),
      sessionStartTimestamp: Date.now(),
      activeDurationSeconds: 0,
      lastActivityTimestamp: Date.now(),
      agentSwitches: 0,
    },
    recapCache: {},
    rotationMetadata: {},
  }
}

/**
 * Partial update types for normalized event updates.
 * Each update type handles a specific domain to ensure
 * partial updates do NOT wipe unrelated valid state.
 */
export type PresenceUpdate =
  | { type: "identity"; payload: Partial<AgentIdentity> }
  | { type: "idle"; payload: boolean }
  | { type: "fileAction"; payload: Partial<FileAction> }
  | { type: "todoSummary"; payload: Partial<TodoSummary> }
  | { type: "diagnosticsSummary"; payload: Partial<DiagnosticsSummary> }
  | { type: "sessionMetrics"; payload: Partial<SessionMetrics> }
  | { type: "recapCache"; payload: Partial<RecapCache> }
  | { type: "rotationMetadata"; payload: Partial<RotationMetadata> }
  | { type: "batch"; payload: PresenceUpdate[] }

/**
 * Helper to safely merge Set fields during partial updates.
 */
function mergeSet<T>(existing: Set<T>, incoming: Set<T> | T[]): Set<T> {
  const result = new Set(existing)
  const items = Array.isArray(incoming) ? incoming : Array.from(incoming)
  for (const item of items) {
    result.add(item)
  }
  return result
}

/**
 * Presence reducer for partial normalized updates.
 * Ensures that applying a partial update does NOT wipe unrelated fields.
 */
export function presenceReducer(state: PresenceSnapshot, update: PresenceUpdate): PresenceSnapshot {
  switch (update.type) {
    case "identity":
      return {
        ...state,
        identity: { ...state.identity, ...update.payload },
      }

    case "idle":
      return {
        ...state,
        idle: update.payload,
      }

    case "fileAction":
      return {
        ...state,
        fileAction: { ...state.fileAction, ...update.payload },
      }

    case "todoSummary":
      return {
        ...state,
        todoSummary: { ...state.todoSummary, ...update.payload },
      }

    case "diagnosticsSummary":
      return {
        ...state,
        diagnosticsSummary: { ...state.diagnosticsSummary, ...update.payload },
      }

    case "sessionMetrics": {
      const current = state.sessionMetrics
      const incoming = update.payload
      return {
        ...state,
        sessionMetrics: {
          ...current,
          ...incoming,
          uniqueFilesTouched: incoming.uniqueFilesTouched
            ? mergeSet(current.uniqueFilesTouched, incoming.uniqueFilesTouched)
            : current.uniqueFilesTouched,
        },
      }
    }

    case "recapCache":
      return {
        ...state,
        recapCache: { ...state.recapCache, ...update.payload },
      }

    case "rotationMetadata":
      return {
        ...state,
        rotationMetadata: { ...state.rotationMetadata, ...update.payload },
      }

    case "batch": {
      return update.payload.reduce(presenceReducer, state)
    }

    default:
      return state
  }
}

/**
 * Helper to create an identity update.
 */
export function updateIdentity(identity: Partial<AgentIdentity>): PresenceUpdate {
  return { type: "identity", payload: identity }
}

/**
 * Helper to create an idle update.
 */
export function updateIdle(idle: boolean): PresenceUpdate {
  return { type: "idle", payload: idle }
}

/**
 * Helper to create a fileAction update.
 */
export function updateFileAction(fileAction: Partial<FileAction>): PresenceUpdate {
  return { type: "fileAction", payload: fileAction }
}

/**
 * Helper to create a todoSummary update.
 */
export function updateTodoSummary(todoSummary: Partial<TodoSummary>): PresenceUpdate {
  return { type: "todoSummary", payload: todoSummary }
}

/**
 * Helper to create a diagnosticsSummary update.
 */
export function updateDiagnosticsSummary(
  diagnosticsSummary: Partial<DiagnosticsSummary>,
): PresenceUpdate {
  return { type: "diagnosticsSummary", payload: diagnosticsSummary }
}

/**
 * Helper to create a sessionMetrics update.
 */
export function updateSessionMetrics(sessionMetrics: Partial<SessionMetrics>): PresenceUpdate {
  return { type: "sessionMetrics", payload: sessionMetrics }
}

/**
 * Helper to create a recapCache update.
 */
export function updateRecapCache(recapCache: Partial<RecapCache>): PresenceUpdate {
  return { type: "recapCache", payload: recapCache }
}

/**
 * Helper to create a rotationMetadata update.
 */
export function updateRotationMetadata(
  rotationMetadata: Partial<RotationMetadata>,
): PresenceUpdate {
  return { type: "rotationMetadata", payload: rotationMetadata }
}
