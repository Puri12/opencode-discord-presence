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

  test("F8: two instances writing concurrently do NOT clobber each other (per-instance file)", async () => {
    const { saveSessionMetrics, loadSessionMetrics, clearSessionMetrics } = await import(
      "./session-persistence"
    )

    const metricsA: SessionMetricsState = {
      messageCount: 10,
      uniqueFilesTouched: new Set(["a.ts"]),
      sessionStartTimestamp: 1_000,
      activeDurationSeconds: 100,
      lastActivityTimestamp: 1_100,
      agentSwitches: 1,
    }
    const metricsB: SessionMetricsState = {
      messageCount: 99,
      uniqueFilesTouched: new Set(["b.ts", "c.ts"]),
      sessionStartTimestamp: 2_000,
      activeDurationSeconds: 200,
      lastActivityTimestamp: 2_200,
      agentSwitches: 2,
    }

    await saveSessionMetrics(metricsA, testDir, { instanceId: "alpha" })
    await saveSessionMetrics(metricsB, testDir, { instanceId: "beta" })

    const loadedA = await loadSessionMetrics(testDir, { instanceId: "alpha" })
    const loadedB = await loadSessionMetrics(testDir, { instanceId: "beta" })

    expect(loadedA?.messageCount).toBe(10)
    expect(loadedA?.uniqueFilesTouched).toEqual(new Set(["a.ts"]))
    expect(loadedB?.messageCount).toBe(99)
    expect(loadedB?.uniqueFilesTouched).toEqual(new Set(["b.ts", "c.ts"]))

    await clearSessionMetrics(testDir, { instanceId: "alpha" })
    expect(await loadSessionMetrics(testDir, { instanceId: "alpha" })).toBeNull()
    expect((await loadSessionMetrics(testDir, { instanceId: "beta" }))?.messageCount).toBe(99)

    await clearSessionMetrics(testDir, { instanceId: "beta" })
  })

  test("F8: clearSessionMetrics for one instance does not delete another instance's file", async () => {
    const { saveSessionMetrics, loadSessionMetrics, clearSessionMetrics } = await import(
      "./session-persistence"
    )
    const metrics: SessionMetricsState = {
      messageCount: 7,
      uniqueFilesTouched: new Set(),
      sessionStartTimestamp: Date.now(),
      activeDurationSeconds: 0,
      lastActivityTimestamp: Date.now(),
      agentSwitches: 0,
    }
    await saveSessionMetrics(metrics, testDir, { instanceId: "keep" })
    await saveSessionMetrics(metrics, testDir, { instanceId: "drop" })

    await clearSessionMetrics(testDir, { instanceId: "drop" })

    expect((await loadSessionMetrics(testDir, { instanceId: "keep" }))?.messageCount).toBe(7)
    expect(await loadSessionMetrics(testDir, { instanceId: "drop" })).toBeNull()
    await clearSessionMetrics(testDir, { instanceId: "keep" })
  })

  test("pruneStaleSessionMetrics removes orphan per-instance files older than threshold", async () => {
    const { saveSessionMetrics, pruneStaleSessionMetrics, loadSessionMetrics } = await import(
      "./session-persistence"
    )

    const freshMetrics: SessionMetricsState = {
      messageCount: 1,
      uniqueFilesTouched: new Set(),
      sessionStartTimestamp: Date.now(),
      activeDurationSeconds: 0,
      lastActivityTimestamp: Date.now(),
      agentSwitches: 0,
    }
    await saveSessionMetrics(freshMetrics, testDir, { instanceId: "fresh" })

    const stalePath = join(testDir, "session-metrics-stale.json")
    writeFileSync(
      stalePath,
      JSON.stringify({
        messageCount: 99,
        uniqueFilesTouched: [],
        sessionStartTimestamp: Date.now() - 60 * 60 * 1000,
        activeDurationSeconds: 0,
        lastActivityTimestamp: Date.now() - 60 * 60 * 1000,
        agentSwitches: 0,
        savedAt: Date.now() - 60 * 60 * 1000,
      }),
    )

    const removed = await pruneStaleSessionMetrics(testDir)
    expect(removed).toContain("session-metrics-stale.json")
    expect(removed).not.toContain("session-metrics-fresh.json")

    expect((await loadSessionMetrics(testDir, { instanceId: "fresh" }))?.messageCount).toBe(1)
  })

  test("pruneStaleSessionMetrics keeps file matching keepInstanceId even if stale by mtime", async () => {
    const { pruneStaleSessionMetrics } = await import("./session-persistence")

    const keepPath = join(testDir, "session-metrics-mine.json")
    writeFileSync(
      keepPath,
      JSON.stringify({
        messageCount: 0,
        uniqueFilesTouched: [],
        sessionStartTimestamp: Date.now() - 60 * 60 * 1000,
        activeDurationSeconds: 0,
        lastActivityTimestamp: Date.now() - 60 * 60 * 1000,
        agentSwitches: 0,
        savedAt: Date.now() - 60 * 60 * 1000,
      }),
    )

    const removed = await pruneStaleSessionMetrics(testDir, { keepInstanceId: "mine" })

    expect(removed).not.toContain("session-metrics-mine.json")
  })

  test("pruneStaleSessionMetrics ignores legacy session-metrics.json (no -<id> suffix)", async () => {
    const { pruneStaleSessionMetrics } = await import("./session-persistence")
    const legacyPath = join(testDir, "session-metrics.json")
    writeFileSync(
      legacyPath,
      JSON.stringify({
        messageCount: 0,
        uniqueFilesTouched: [],
        sessionStartTimestamp: Date.now() - 60 * 60 * 1000,
        activeDurationSeconds: 0,
        lastActivityTimestamp: Date.now() - 60 * 60 * 1000,
        agentSwitches: 0,
        savedAt: Date.now() - 60 * 60 * 1000,
      }),
    )

    const removed = await pruneStaleSessionMetrics(testDir)
    expect(removed).not.toContain("session-metrics.json")
  })

  test("pruneStaleSessionMetrics is safe when dir does not exist", async () => {
    const { pruneStaleSessionMetrics } = await import("./session-persistence")
    const removed = await pruneStaleSessionMetrics(join(testDir, "nonexistent"))
    expect(removed).toEqual([])
  })
})
