import { describe, expect, test } from "bun:test"
import {
  clearLiveContext,
  createSessionMetricsState,
  createSessionRecap,
  recordFileTouch,
  recordMessageActivity,
  recordTaskContext,
} from "./session-metrics"

describe("session-metrics", () => {
  test("increments message count and deduplicates normalized file touches", () => {
    let metrics = createSessionMetricsState(1_000)

    metrics = recordMessageActivity(metrics, 6_000)
    metrics = recordMessageActivity(metrics, 16_000)
    metrics = recordFileTouch(metrics, "src\\plugin.ts", 26_000)
    metrics = recordFileTouch(metrics, "src/plugin.ts", 36_000)
    metrics = recordFileTouch(metrics, "./src/plugin.ts", 46_000)

    expect(metrics.messageCount).toBe(2)
    expect(metrics.uniqueFilesTouched.size).toBe(1)
    expect(Array.from(metrics.uniqueFilesTouched)).toEqual(["src/plugin.ts"])
    expect(metrics.lastFileContext).toBe("src/plugin.ts")
    expect(metrics.activeDurationSeconds).toBe(45)
    expect(metrics.lastActivityTimestamp).toBe(46_000)
  })

  test("retains the last meaningful task and file context for recap composition", () => {
    let metrics = createSessionMetricsState(5_000)

    metrics = recordTaskContext(metrics, "Implement rotation engine", 15_000)
    metrics = recordFileTouch(metrics, "src/state/presence-state.ts", 25_000)
    metrics = clearLiveContext(metrics)

    const recap = createSessionRecap(metrics, 35_000)

    expect(metrics.lastTaskContext).toBe("Implement rotation engine")
    expect(metrics.lastFileContext).toBe("src/state/presence-state.ts")
    expect(recap.lastTaskContext).toBe("Implement rotation engine")
    expect(recap.lastFileContext).toBe("src/state/presence-state.ts")
    expect(recap.timestamp).toBe(35_000)
  })

  test("produces recap data that survives later live-state changes", () => {
    let metrics = createSessionMetricsState(10_000)

    metrics = recordMessageActivity(metrics, 20_000)
    metrics = recordTaskContext(metrics, "Summarize session", 30_000)
    metrics = recordFileTouch(metrics, "src/utils/session-metrics.ts", 60_000)

    const recap = createSessionRecap(metrics, 60_000)
    metrics = clearLiveContext(metrics)
    metrics = recordTaskContext(metrics, "New session task", 70_000)
    metrics = recordFileTouch(metrics, "src/plugin.ts", 80_000)

    expect(recap.messageCount).toBe(1)
    expect(recap.filesTouched).toEqual(["src/utils/session-metrics.ts"])
    expect(recap.uniqueFileCount).toBe(1)
    expect(recap.activeDurationSeconds).toBe(50)
    expect(recap.lastTaskContext).toBe("Summarize session")
    expect(recap.lastFileContext).toBe("src/utils/session-metrics.ts")

    expect(metrics.lastTaskContext).toBe("New session task")
    expect(metrics.lastFileContext).toBe("src/plugin.ts")
  })
})
