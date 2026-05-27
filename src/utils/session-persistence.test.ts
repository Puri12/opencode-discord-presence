import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionMetricsState } from "../utils/session-metrics"

const testDir = join(tmpdir(), `session-persistence-test-${Date.now()}`)

beforeEach(() => mkdirSync(testDir, { recursive: true }))
afterEach(() => rmSync(testDir, { recursive: true, force: true }))

describe("session-persistence", () => {
  test("save and load roundtrip preserves all fields", async () => {
    const { saveSessionMetrics, loadSessionMetrics, clearSessionMetrics } = await import(
      "./session-persistence"
    )
    const mockMetrics: SessionMetricsState = {
      messageCount: 5,
      uniqueFilesTouched: new Set(["a.ts", "b.ts"]),
      sessionStartTimestamp: 1_000_000_000_000,
      activeDurationSeconds: 300,
      lastActivityTimestamp: 1_000_000_000_300,
      agentSwitches: 2,
    }

    await saveSessionMetrics(mockMetrics, testDir)
    const loaded = await loadSessionMetrics(testDir)

    expect(loaded?.messageCount).toBe(5)
    expect(loaded?.uniqueFilesTouched).toEqual(new Set(["a.ts", "b.ts"]))
    expect(loaded?.sessionStartTimestamp).toBe(1_000_000_000_000)
    expect(loaded?.activeDurationSeconds).toBe(300)
    expect(loaded?.agentSwitches).toBe(2)

    await clearSessionMetrics(testDir)
  })

  test("loadSessionMetrics returns null when file missing", async () => {
    const { loadSessionMetrics } = await import("./session-persistence")
    const result = await loadSessionMetrics(testDir)
    expect(result).toBeNull()
  })

  test("loadSessionMetrics returns null when JSON corrupted", async () => {
    const { loadSessionMetrics } = await import("./session-persistence")
    writeFileSync(join(testDir, "session-metrics.json"), "{ broken json", { encoding: "utf8" })
    const result = await loadSessionMetrics(testDir)
    expect(result).toBeNull()
  })

  test("clearSessionMetrics deletes the file", async () => {
    const { saveSessionMetrics, clearSessionMetrics, loadSessionMetrics } = await import(
      "./session-persistence"
    )
    const mockMetrics: SessionMetricsState = {
      messageCount: 1,
      uniqueFilesTouched: new Set(),
      sessionStartTimestamp: Date.now(),
      activeDurationSeconds: 0,
      lastActivityTimestamp: Date.now(),
      agentSwitches: 0,
    }
    await saveSessionMetrics(mockMetrics, testDir)
    await clearSessionMetrics(testDir)
    const result = await loadSessionMetrics(testDir)
    expect(result).toBeNull()
  })

  test("loadSessionMetrics returns null for stale session (older than 30 min)", async () => {
    const { loadSessionMetrics } = await import("./session-persistence")
    const stalePath = join(testDir, "session-metrics.json")
    const staleSerialized = {
      messageCount: 99,
      uniqueFilesTouched: ["stale.ts"],
      sessionStartTimestamp: Date.now() - 45 * 60 * 1000,
      activeDurationSeconds: 2700,
      lastActivityTimestamp: Date.now() - 45 * 60 * 1000,
      agentSwitches: 5,
      savedAt: Date.now() - 45 * 60 * 1000,
    }
    writeFileSync(stalePath, JSON.stringify(staleSerialized), "utf8")

    const result = await loadSessionMetrics(testDir)
    expect(result).toBeNull()
  })

  test("session metrics are cleared after clearSessionMetrics is called", async () => {
    const { saveSessionMetrics, loadSessionMetrics, clearSessionMetrics } = await import(
      "./session-persistence"
    )
    const metrics: SessionMetricsState = {
      messageCount: 5,
      uniqueFilesTouched: new Set(["x.ts"]),
      sessionStartTimestamp: Date.now(),
      activeDurationSeconds: 10,
      lastActivityTimestamp: Date.now(),
      agentSwitches: 0,
    }
    await saveSessionMetrics(metrics, testDir)
    await clearSessionMetrics(testDir)
    const result = await loadSessionMetrics(testDir)
    expect(result).toBeNull()
  })
})
