import { mkdirSync, unlinkSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { SessionMetricsState } from "./session-metrics"

const SESSION_DIR = ".opencode-discord-presence"
const SESSION_FILE = "session-metrics.json"

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

export type SerializedSessionMetrics = {
  messageCount: number
  uniqueFilesTouched: string[]
  sessionStartTimestamp: number
  activeDurationSeconds: number
  lastActivityTimestamp: number
  agentSwitches: number
  savedAt: number
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000

export type PersistenceSessionMetrics = Omit<SerializedSessionMetrics, "uniqueFilesTouched"> & {
  uniqueFilesTouched: string[]
}

export async function saveSessionMetrics(
  metrics: SessionMetricsState,
  dir?: string,
): Promise<void> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const filePath = join(baseDir, SESSION_FILE)

  ensureDir(baseDir)

  const serialized: PersistenceSessionMetrics = {
    messageCount: metrics.messageCount,
    uniqueFilesTouched: Array.from(metrics.uniqueFilesTouched),
    sessionStartTimestamp: metrics.sessionStartTimestamp,
    activeDurationSeconds: metrics.activeDurationSeconds,
    lastActivityTimestamp: metrics.lastActivityTimestamp,
    agentSwitches: metrics.agentSwitches,
    savedAt: Date.now(),
  }

  const json = JSON.stringify(serialized)
  await writeFile(filePath, json)
}

export async function loadSessionMetrics(dir?: string): Promise<SessionMetricsState | null> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const filePath = join(baseDir, SESSION_FILE)

  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return null
  }

  try {
    const serialized: SerializedSessionMetrics = JSON.parse(content)

    const isStale = !serialized.savedAt || Date.now() - serialized.savedAt > STALE_THRESHOLD_MS
    if (isStale) {
      return null
    }

    return {
      messageCount: serialized.messageCount,
      uniqueFilesTouched: new Set(serialized.uniqueFilesTouched),
      sessionStartTimestamp: serialized.sessionStartTimestamp,
      activeDurationSeconds: serialized.activeDurationSeconds,
      lastActivityTimestamp: serialized.lastActivityTimestamp,
      agentSwitches: serialized.agentSwitches,
    }
  } catch {
    return null
  }
}

export async function clearSessionMetrics(dir?: string): Promise<void> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const filePath = join(baseDir, SESSION_FILE)

  try {
    unlinkSync(filePath)
  } catch {
    // File didn't exist — that's fine
  }
}
