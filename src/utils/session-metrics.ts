import type { RecapCache, SessionMetrics } from "../state/presence-state"

export interface SessionMetricsState extends SessionMetrics {
  currentTaskContext?: string
  currentFileContext?: string
  lastTaskContext?: string
  lastFileContext?: string
}

export interface SessionRecapData extends RecapCache {
  uniqueFileCount: number
  activeDurationSeconds: number
  lastTaskContext?: string
  lastFileContext?: string
}

function toSeconds(milliseconds: number): number {
  return Math.max(0, Math.floor(milliseconds / 1000))
}

export function normalizeFileIdentity(filePath: string): string {
  return filePath.replace(/\\+/g, "/").replace(/^\.\//, "")
}

function withActivityTimestamp(
  metrics: SessionMetricsState,
  timestamp: number,
): SessionMetricsState {
  return {
    ...metrics,
    activeDurationSeconds: toSeconds(timestamp - metrics.sessionStartTimestamp),
    lastActivityTimestamp: timestamp,
  }
}

export function createSessionMetricsState(sessionStartTimestamp = Date.now()): SessionMetricsState {
  return {
    messageCount: 0,
    uniqueFilesTouched: new Set<string>(),
    sessionStartTimestamp,
    activeDurationSeconds: 0,
    lastActivityTimestamp: sessionStartTimestamp,
    agentSwitches: 0,
  }
}

export function recordMessageActivity(
  metrics: SessionMetricsState,
  timestamp = Date.now(),
): SessionMetricsState {
  return withActivityTimestamp(
    {
      ...metrics,
      messageCount: metrics.messageCount + 1,
    },
    timestamp,
  )
}

export function recordFileTouch(
  metrics: SessionMetricsState,
  filePath: string,
  timestamp = Date.now(),
): SessionMetricsState {
  const normalizedFile = normalizeFileIdentity(filePath)
  const uniqueFilesTouched = new Set(metrics.uniqueFilesTouched)
  uniqueFilesTouched.add(normalizedFile)

  return withActivityTimestamp(
    {
      ...metrics,
      uniqueFilesTouched,
      currentFileContext: normalizedFile,
      lastFileContext: normalizedFile,
    },
    timestamp,
  )
}

export function recordTaskContext(
  metrics: SessionMetricsState,
  taskLabel: string,
  timestamp = Date.now(),
): SessionMetricsState {
  return withActivityTimestamp(
    {
      ...metrics,
      currentTaskContext: taskLabel,
      lastTaskContext: taskLabel,
    },
    timestamp,
  )
}

export function clearLiveContext(metrics: SessionMetricsState): SessionMetricsState {
  return {
    ...metrics,
    currentTaskContext: undefined,
    currentFileContext: undefined,
  }
}

export function createSessionRecap(
  metrics: SessionMetricsState,
  timestamp = Date.now(),
): SessionRecapData {
  return {
    timestamp,
    messageCount: metrics.messageCount,
    filesTouched: Array.from(metrics.uniqueFilesTouched),
    uniqueFileCount: metrics.uniqueFilesTouched.size,
    activeDurationSeconds: toSeconds(timestamp - metrics.sessionStartTimestamp),
    lastTaskContext: metrics.lastTaskContext,
    lastFileContext: metrics.lastFileContext,
  }
}
