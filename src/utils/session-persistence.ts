import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { SessionMetricsState } from "./session-metrics"

const SESSION_DIR = ".opencode-discord-presence"
const LEGACY_SESSION_FILE = "session-metrics.json"
const PER_INSTANCE_PREFIX = "session-metrics-"
const PER_INSTANCE_SUFFIX = ".json"

export interface PersistenceOptions {
  instanceId?: string
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function sanitizeInstanceId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_")
}

function resolveFile(baseDir: string, options?: PersistenceOptions): string {
  if (options?.instanceId) {
    return join(baseDir, `session-metrics-${sanitizeInstanceId(options.instanceId)}.json`)
  }
  return join(baseDir, LEGACY_SESSION_FILE)
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
  options?: PersistenceOptions,
): Promise<void> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const filePath = resolveFile(baseDir, options)

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
  await Bun.write(filePath, json)
}

export async function loadSessionMetrics(
  dir?: string,
  options?: PersistenceOptions,
): Promise<SessionMetricsState | null> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const filePath = resolveFile(baseDir, options)

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return null
  }

  try {
    const serialized: SerializedSessionMetrics = await file.json()

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

export async function clearSessionMetrics(
  dir?: string,
  options?: PersistenceOptions,
): Promise<void> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const filePath = resolveFile(baseDir, options)

  try {
    unlinkSync(filePath)
  } catch {
    // File didn't exist — that's fine
  }
}

export interface PruneOptions {
  keepInstanceId?: string
  staleThresholdMs?: number
}

/**
 * Removes orphan per-instance session-metrics files left behind by crashed
 * or restarted CLI processes. Without this, every random instanceId from a
 * fresh plugin init accumulates a stale file forever.
 *
 * Returns the list of removed filenames so callers can log/test cleanup.
 */
export async function pruneStaleSessionMetrics(
  dir?: string,
  options?: PruneOptions,
): Promise<string[]> {
  const baseDir = dir ?? join(homedir(), SESSION_DIR)
  const staleMs = options?.staleThresholdMs ?? STALE_THRESHOLD_MS
  const removed: string[] = []

  const entries = readEntriesSafe(baseDir)
  if (entries.length === 0) return removed

  const now = Date.now()
  for (const name of entries) {
    if (!isPruneCandidate(name, options?.keepInstanceId)) continue
    const filePath = join(baseDir, name)
    if (!isStaleMetricsFile(filePath, now, staleMs)) continue
    if (tryUnlink(filePath)) removed.push(name)
  }

  return removed
}

function readEntriesSafe(baseDir: string): string[] {
  try {
    return readdirSync(baseDir)
  } catch {
    return []
  }
}

function isPruneCandidate(name: string, keepInstanceId?: string): boolean {
  if (!name.startsWith(PER_INSTANCE_PREFIX) || !name.endsWith(PER_INSTANCE_SUFFIX)) return false
  if (!keepInstanceId) return true
  const instanceId = name.slice(PER_INSTANCE_PREFIX.length, -PER_INSTANCE_SUFFIX.length)
  return instanceId !== keepInstanceId
}

function tryUnlink(filePath: string): boolean {
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

function isStaleMetricsFile(filePath: string, now: number, staleMs: number): boolean {
  const savedAt = readSavedAt(filePath)
  if (savedAt !== null) return now - savedAt > staleMs
  return mtimeOlderThan(filePath, now, staleMs)
}

function readSavedAt(filePath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as { savedAt?: unknown }
    if (typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)) {
      return parsed.savedAt
    }
  } catch {
    // unparseable or missing — caller falls back to mtime
  }
  return null
}

function mtimeOlderThan(filePath: string, now: number, staleMs: number): boolean {
  try {
    return now - statSync(filePath).mtimeMs > staleMs
  } catch {
    return false
  }
}
