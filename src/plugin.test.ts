import { describe, expect, test } from "bun:test"
import {
  buildInstancesDir,
  createOwnershipHandler,
  createRecapScheduler,
  isPrimaryPluginInstance,
  releasePrimaryPluginInstance,
  startPluginAsync,
} from "./plugin.js"
import type { DiscordRPCService } from "./services/discord-rpc.js"
import {
  createInitialPresenceState,
  presenceReducer,
  updateFileAction,
  updateIdentity,
  updateIdle,
  updateRecapCache,
  updateTodoSummary,
} from "./state/presence-state.js"
import type { RichPresenceOptions } from "./types/index.js"
import { getActivity } from "./utils/activity-rotation.js"
import {
  createSessionMetricsState,
  createSessionRecap,
  normalizeFileIdentity,
  recordFileTouch,
  recordMessageActivity,
  recordTaskContext,
} from "./utils/session-metrics.js"
import { getToolLabel } from "./utils/tool-label.js"

// ─── normalizeFileIdentity ────────────────────────────────────────────────────

describe("normalizeFileIdentity", () => {
  test("strips leading ./ from relative paths", () => {
    expect(normalizeFileIdentity("./src/index.ts")).toBe("src/index.ts")
  })

  test("normalizes backslashes to forward slashes", () => {
    expect(normalizeFileIdentity("src\\index.ts")).toBe("src/index.ts")
  })

  test("preserves absolute paths unchanged", () => {
    // normalizeFileIdentity is for deduplication, not display - absolute paths preserved
    expect(normalizeFileIdentity("/workspace/src/index.ts")).toBe("/workspace/src/index.ts")
  })
})

// ─── getToolLabel ─────────────────────────────────────────────────────────────

describe("getToolLabel", () => {
  test("maps file.edited to Editing", () => {
    expect(getToolLabel({ eventName: "file.edited" })).toBe("Editing")
  })

  test("maps lsp.client.diagnostics to Diagnosing", () => {
    expect(getToolLabel({ eventName: "lsp.client.diagnostics" })).toBe("Diagnosing")
  })

  test("maps edit tool to Editing", () => {
    expect(getToolLabel({ toolName: "edit" })).toBe("Editing")
  })

  test("maps read tool to Reading", () => {
    expect(getToolLabel({ toolName: "read" })).toBe("Reading")
  })

  test("maps grep/search tools to Searching", () => {
    expect(getToolLabel({ toolName: "grep" })).toBe("Searching")
  })

  test("unknown tool falls back to Working", () => {
    expect(getToolLabel({ toolName: "unknown-tool" })).toBe("Working")
  })

  test("bash with test command infers Running tests", () => {
    expect(getToolLabel({ toolName: "bash", command: "bun test" })).toBe("Running tests")
  })

  test("bash with build command infers Building", () => {
    expect(getToolLabel({ toolName: "bash", command: "npm run build" })).toBe("Building")
  })

  test("bash with generic command returns Executing", () => {
    expect(getToolLabel({ toolName: "bash", command: "ls -la" })).toBe("Executing")
  })
})

// ─── PresenceSnapshot state transitions ───────────────────────────────────────

describe("PresenceSnapshot state transitions", () => {
  test("chat.message updates identity and increments message count", () => {
    let snapshot = createInitialPresenceState()
    let metrics = createSessionMetricsState()

    snapshot = presenceReducer(
      snapshot,
      updateIdentity({ agent: "Claude", model: "claude-3-sonnet" }),
    )
    metrics = recordMessageActivity(metrics)

    expect(snapshot.identity.agent).toBe("Claude")
    expect(snapshot.identity.model).toBe("claude-3-sonnet")
    expect(metrics.messageCount).toBe(1)
  })

  test("tool.execute.before updates file context and clears idle via exitIdleIfNeeded", () => {
    let snapshot = createInitialPresenceState()
    let metrics = createSessionMetricsState()

    // Set idle first
    snapshot = presenceReducer(snapshot, updateIdle(true))
    expect(snapshot.idle).toBe(true)

    // exitIdleIfNeeded() clears idle before file action update (matches plugin flow)
    if (snapshot.idle) {
      snapshot = presenceReducer(snapshot, updateIdle(false))
    }

    // Simulate tool execution
    const filePath = normalizeFileIdentity("./src/plugin.ts")
    snapshot = presenceReducer(
      snapshot,
      updateFileAction({
        file: filePath,
        action: "edit",
        operation: "Editing",
      }),
    )
    metrics = recordFileTouch(metrics, filePath)

    expect(snapshot.idle).toBe(false)
    expect(snapshot.fileAction.file).toBe("src/plugin.ts")
    expect(snapshot.fileAction.operation).toBe("Editing")
  })

  test("file.edited event updates file context", () => {
    let snapshot = createInitialPresenceState()

    const filePath = normalizeFileIdentity("./src/app.ts")
    snapshot = presenceReducer(
      snapshot,
      updateFileAction({
        file: filePath,
        action: "edit",
        operation: "Editing",
      }),
    )

    expect(snapshot.fileAction.file).toBe("src/app.ts")
    expect(snapshot.fileAction.operation).toBe("Editing")
  })

  test("session.idle sets idle flag", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdle(true))
    expect(snapshot.idle).toBe(true)
  })

  test("session.deleted populates recap cache", () => {
    let snapshot = createInitialPresenceState()
    let metrics = createSessionMetricsState()

    metrics = recordMessageActivity(metrics)
    metrics = recordFileTouch(metrics, normalizeFileIdentity("./src/a.ts"))

    const recap = createSessionRecap(metrics)
    snapshot = presenceReducer(snapshot, updateRecapCache({ ...recap, timestamp: Date.now() }))

    expect(snapshot.recapCache.timestamp).toBeDefined()
    expect(snapshot.recapCache.messageCount).toBe(1)
    expect(snapshot.recapCache.uniqueFileCount).toBe(1)
  })

  test("exitIdleIfNeeded clears idle on any active event", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdle(true))
    expect(snapshot.idle).toBe(true)

    // Any subsequent active event calls exitIdleIfNeeded()
    if (snapshot.idle) {
      snapshot = presenceReducer(snapshot, updateIdle(false))
    }

    expect(snapshot.idle).toBe(false)
  })
})

// ─── todo.updated event processing ───────────────────────────────────────────

describe("todo.updated event processing", () => {
  test("computes todo summary correctly from todos array", () => {
    let snapshot = createInitialPresenceState()

    const todos = [
      { content: "Task 1", status: "completed" },
      { content: "Task 2", status: "in_progress" },
      { content: "Task 3", status: "pending" },
    ]

    const total = todos.length
    const completed = todos.filter((t) => t.status === "completed").length
    const pending = total - completed
    const allDone = completed === total && total > 0
    const activeTodo =
      todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending")
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

    expect(snapshot.todoSummary.total).toBe(3)
    expect(snapshot.todoSummary.completed).toBe(1)
    expect(snapshot.todoSummary.pending).toBe(2)
    expect(snapshot.todoSummary.allDone).toBe(false)
    expect(snapshot.todoSummary.activeTaskLabel).toBe("Task 2")
  })

  test("detects all-done state", () => {
    let snapshot = createInitialPresenceState()

    const todos = [
      { content: "Task 1", status: "completed" },
      { content: "Task 2", status: "completed" },
    ]

    const total = todos.length
    const completed = todos.filter((t) => t.status === "completed").length
    const allDone = completed === total && total > 0

    snapshot = presenceReducer(
      snapshot,
      updateTodoSummary({ total, completed, pending: 0, allDone }),
    )

    expect(snapshot.todoSummary.allDone).toBe(true)
  })

  test("handles empty todos gracefully", () => {
    let snapshot = createInitialPresenceState()

    const todos: Array<{ content?: string; status?: string }> = []
    const total = todos.length
    const completed = todos.filter((t) => t.status === "completed").length

    snapshot = presenceReducer(
      snapshot,
      updateTodoSummary({ total, completed, pending: 0, allDone: false }),
    )

    expect(snapshot.todoSummary.total).toBe(0)
    expect(snapshot.todoSummary.allDone).toBe(false)
  })

  test("handles missing todos by preserving prior state", () => {
    let snapshot = createInitialPresenceState()

    // Pre-populate some todo state
    snapshot = presenceReducer(
      snapshot,
      updateTodoSummary({
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Task A",
      }),
    )

    // Empty update — preserves state
    const before = { ...snapshot.todoSummary }
    snapshot = presenceReducer(snapshot, updateTodoSummary({}))
    expect(snapshot.todoSummary).toEqual(before)
  })

  test("partial todoSummary update preserves unrelated fields", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(
      snapshot,
      updateTodoSummary({
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Task A",
      }),
    )

    // Only update completion counts
    snapshot = presenceReducer(snapshot, updateTodoSummary({ completed: 3, pending: 2 }))

    expect(snapshot.todoSummary.total).toBe(5) // preserved
    expect(snapshot.todoSummary.activeTaskLabel).toBe("Task A") // preserved
    expect(snapshot.todoSummary.completed).toBe(3)
    expect(snapshot.todoSummary.pending).toBe(2)
  })
})

// ─── Rotation logic ──────────────────────────────────────────────────────────

describe("rotation logic", () => {
  test("countRotatingCards computes correctly", () => {
    function countRotatingCards(
      enableFileSpotlight: boolean,
      enableMissionBoard: boolean,
      hasWarnings: boolean,
      errors: number,
    ): number {
      let count = 0
      if (enableFileSpotlight) count++
      if (enableMissionBoard) count++
      if (hasWarnings && errors === 0) count++
      count++ // session-stats always present
      return Math.max(count, 1)
    }

    expect(countRotatingCards(true, true, false, 0)).toBe(3)
    expect(countRotatingCards(true, true, true, 0)).toBe(4)
    expect(countRotatingCards(true, true, true, 5)).toBe(3)
    expect(countRotatingCards(true, false, false, 0)).toBe(2)
    expect(countRotatingCards(false, false, false, 0)).toBe(1)
  })

  test("rotation index wraps around correctly", () => {
    const cardCount = 3
    let index = 0

    index = (index + 1) % cardCount
    expect(index).toBe(1)

    index = (index + 1) % cardCount
    expect(index).toBe(2)

    index = (index + 1) % cardCount
    expect(index).toBe(0)

    index = (index + 1) % cardCount
    expect(index).toBe(1)
  })
})

// ─── getActivity integration ─────────────────────────────────────────────────

describe("getActivity integration with snapshot", () => {
  const defaultOpts: RichPresenceOptions = {
    enableFileSpotlight: true,
    enableMissionBoard: true,
    rotationIntervalSeconds: 20,
    diagnostics: { errorsOnly: true },
    mainAgentOnly: false,
  }

  test("idle state shows best available context", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude" }))
    snapshot = presenceReducer(
      snapshot,
      updateTodoSummary({
        total: 3,
        completed: 1,
        pending: 2,
        allDone: false,
        activeTaskLabel: "Implement feature X",
      }),
    )
    snapshot = presenceReducer(snapshot, updateIdle(true))

    const activity = getActivity(snapshot, defaultOpts, 0)

    expect(activity.details).toBe("Claude is idle")
    expect(activity.state).toContain("Last task:")
    expect(activity.state).toContain("Implement feature X")
  })

  test("active operation + file spotlight uses plain working details", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude" }))
    // Use workspace-relative path (no leading ./) since formatFileLabel returns basename
    snapshot = presenceReducer(
      snapshot,
      updateFileAction({
        file: "src/plugin.ts",
        action: "edit",
        operation: "Editing",
      }),
    )

    const activity = getActivity(snapshot, defaultOpts, 0)

    expect(activity.details).toBe("Working with Claude")
    // formatFileLabel with no workspace root returns basename: "plugin.ts"
    expect(activity.state).toContain("plugin.ts")
  })

  test("all-done state pins correctly", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude" }))
    snapshot = presenceReducer(
      snapshot,
      updateTodoSummary({
        total: 5,
        completed: 5,
        pending: 0,
        allDone: true,
      }),
    )

    const activity = getActivity(snapshot, defaultOpts, 0)

    expect(activity.details).toBe("All tasks complete!")
    expect(activity.state).toBe("5/5 finished")
  })

  test("session.deleted recap card shows for fresh recap", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude" }))
    snapshot = presenceReducer(
      snapshot,
      updateRecapCache({
        messageCount: 27,
        filesTouched: ["src/a.ts", "src/b.ts"],
        uniqueFileCount: 2,
        activeDurationSeconds: 3600,
        timestamp: Date.now(),
      }),
    )

    const activity = getActivity(snapshot, defaultOpts, 0)

    expect(activity.details).toBe("Session Complete!")
    expect(activity.state).toContain("27 prompts")
    expect(activity.state).toContain("2 files")
  })

  test("diagnostics-error pins over file rotation", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude" }))
    snapshot = presenceReducer(
      snapshot,
      updateFileAction({
        file: "./src/broken.ts",
        action: "edit",
        operation: "Editing",
      }),
    )
    // Override diagnostics: direct state replacement for test
    snapshot = {
      ...snapshot,
      diagnosticsSummary: { errors: 5, warnings: 2, hints: 0, infos: 0 },
    }

    const activity = getActivity(snapshot, defaultOpts, 0)

    expect(activity.details).toBe("Working with Claude")
    expect(activity.state).toContain("5 errors")
  })
})

// ─── Hook contract regression tests ─────────────────────────────────────────

describe("tool.execute.before → after contract-safe state flow", () => {
  // Simulates the contract-safe before→after callID-scoped context map
  type CapturedContext = {
    filePath?: string
    operation: string
  }
  const callContext = new Map<string, CapturedContext>()

  // Local extractFilePathFromArgs mirroring plugin logic (recursive traversal)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test helper mirrors plugin logic
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

      return normalizeFileIdentity(candidate)
    }
    if (Array.isArray(args)) {
      for (const item of args) {
        const extracted = extractFilePathFromArgs(item)
        if (extracted) return extracted
      }
    }
    if (typeof args === "object") {
      for (const value of Object.values(args as Record<string, unknown>)) {
        const extracted = extractFilePathFromArgs(value)
        if (extracted) return extracted
      }
    }
    return undefined
  }

  function simulateBeforeHook(args: unknown, callID: string, toolName: string, command?: string) {
    const filePath = extractFilePathFromArgs(args)
    const operation = getToolLabel({ toolName, command })
    if (callID) {
      callContext.set(callID, { filePath, operation })
    }
    return { filePath, operation }
  }

  function simulateAfterHook(callID: string, toolName: string) {
    const captured = callContext.get(callID)
    const filePath = captured?.filePath
    const operation = captured?.operation ?? getToolLabel({ toolName })
    if (callID) {
      callContext.delete(callID)
    }
    return { filePath, operation }
  }

  test("after-hook retrieves file context from before-hook capture via callID", () => {
    const callID = "call-123"
    const toolName = "edit"

    // Before hook captures file context from args
    const beforeResult = simulateBeforeHook("./src/plugin.ts", callID, toolName)
    expect(beforeResult.filePath).toBe("src/plugin.ts")
    expect(beforeResult.operation).toBe("Editing")

    // After hook retrieves captured context — NO args needed
    const afterResult = simulateAfterHook(callID, toolName)
    expect(afterResult.filePath).toBe("src/plugin.ts")
    expect(afterResult.operation).toBe("Editing")

    // Context cleaned up after retrieval
    expect(callContext.has(callID)).toBe(false)
  })

  test("before→after flow extracts file path from nested array args", () => {
    const callID = "call-array"

    const beforeResult = simulateBeforeHook(["arg1", '"./src/app.ts"', "arg3"], callID, "edit")
    expect(beforeResult.filePath).toBe("src/app.ts")

    const afterResult = simulateAfterHook(callID, "edit")
    expect(afterResult.filePath).toBe("src/app.ts")
    expect(afterResult.operation).toBe("Editing")
  })

  test("before→after flow extracts file path from nested object args", () => {
    const callID = "call-object"

    const beforeResult = simulateBeforeHook(
      { payload: { file: '"./src/nested/plugin.ts"' } },
      callID,
      "read",
    )
    expect(beforeResult.filePath).toBe("src/nested/plugin.ts")

    const afterResult = simulateAfterHook(callID, "read")
    expect(afterResult.filePath).toBe("src/nested/plugin.ts")
    expect(afterResult.operation).toBe("Reading")
  })

  test("after-hook operates correctly with no prior before-hook capture", () => {
    const callID = "call-no-match"
    const toolName = "read"

    // After hook with no captured context — falls back to getToolLabel
    const result = simulateAfterHook(callID, toolName)
    expect(result.filePath).toBeUndefined()
    expect(result.operation).toBe("Reading")
    expect(callContext.has(callID)).toBe(false) // cleanup still runs
  })

  test("after-hook with no args in before capture returns no file path", () => {
    const callID = "call-no-file"
    const toolName = "bash"

    // Before hook with args that yield no file path (e.g., a command)
    const beforeResult = simulateBeforeHook("bun test", callID, toolName, "bun test")
    expect(beforeResult.filePath).toBeUndefined()
    expect(beforeResult.operation).toBe("Running tests")

    // After hook correctly returns no file path
    const afterResult = simulateAfterHook(callID, toolName)
    expect(afterResult.filePath).toBeUndefined()
    expect(afterResult.operation).toBe("Running tests")
  })

  test("before-hook ignores sparse or non-path args without crashing", () => {
    expect(simulateBeforeHook(undefined, "call-undefined", "grep").filePath).toBeUndefined()
    expect(simulateBeforeHook(null, "call-null", "grep").filePath).toBeUndefined()
    expect(simulateBeforeHook({}, "call-empty-object", "grep").filePath).toBeUndefined()
    expect(simulateBeforeHook([], "call-empty-array", "grep").filePath).toBeUndefined()
    expect(simulateBeforeHook(123, "call-number", "grep").filePath).toBeUndefined()

    expect(callContext.size).toBe(5)

    expect(simulateAfterHook("call-undefined", "grep").filePath).toBeUndefined()
    expect(simulateAfterHook("call-null", "grep").filePath).toBeUndefined()
    expect(simulateAfterHook("call-empty-object", "grep").filePath).toBeUndefined()
    expect(simulateAfterHook("call-empty-array", "grep").filePath).toBeUndefined()
    expect(simulateAfterHook("call-number", "grep").filePath).toBeUndefined()

    expect(callContext.size).toBe(0)
  })

  test("after-hook does NOT read output.args — contract is title/output/metadata only", () => {
    const callID = "call-sparse"
    const toolName = "grep"

    // Simulate before capturing from args
    simulateBeforeHook("--pattern", callID, toolName)

    // Simulate after hook output contract: { title, output, metadata } — NO args
    const afterOutput = {
      title: "grep results",
      output: "matched 5 lines",
      metadata: {},
    }

    // After hook should retrieve from callContext, not from afterOutput.args
    // (afterOutput.args is undefined and should not be accessed)
    const captured = callContext.get(callID)
    expect(captured).toBeDefined()
    expect(captured?.filePath).toBeUndefined() // no file path in args
    expect(captured?.operation).toBe("Searching")

    // Verify no .args access on afterOutput
    expect((afterOutput as unknown as Record<string, unknown>).args).toBeUndefined()

    // Clean up explicitly since this test intentionally skips simulateAfterHook
    callContext.delete(callID)
  })

  test("before-hook does not treat unquoted slash-containing command strings as file paths", () => {
    const beforeResult = simulateBeforeHook(
      "bun test ./src/plugin.ts",
      "call-command",
      "bash",
      "bun test ./src/plugin.ts",
    )

    expect(beforeResult.filePath).toBeUndefined()
    expect(beforeResult.operation).toBe("Running tests")
    callContext.delete("call-command")
  })

  test("multiple sequential before→after cycles work independently", () => {
    const callID1 = "call-a"
    const callID2 = "call-b"
    const callID3 = "call-c"

    simulateBeforeHook('"./src/a.ts"', callID1, "edit", undefined)
    simulateBeforeHook('"./src/b.ts"', callID2, "read", undefined)
    simulateBeforeHook("bun build", callID3, "bash", "bun build")

    // All three contexts coexist
    expect(callContext.get("call-a")?.filePath).toBe("src/a.ts")
    expect(callContext.get("call-b")?.filePath).toBe("src/b.ts")
    expect(callContext.get("call-c")?.filePath).toBeUndefined()

    // Each after-hook retrieves and cleans up independently
    const r1 = simulateAfterHook(callID1, "edit")
    expect(r1.filePath).toBe("src/a.ts")
    expect(r1.operation).toBe("Editing")

    const r2 = simulateAfterHook(callID2, "read")
    expect(r2.filePath).toBe("src/b.ts")
    expect(r2.operation).toBe("Reading")

    const r3 = simulateAfterHook(callID3, "bash")
    expect(r3.filePath).toBeUndefined()
    expect(r3.operation).toBe("Building")

    // All cleaned up
    expect(callContext.size).toBe(0)
  })
})

// ─── Sparse payload tolerance ─────────────────────────────────────────────────

describe("sparse payload tolerance", () => {
  test("partial identity update preserves existing model", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(
      snapshot,
      updateIdentity({ agent: "Claude", model: "claude-3-sonnet" }),
    )
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Prometheus" }))

    expect(snapshot.identity.agent).toBe("Prometheus")
    expect(snapshot.identity.model).toBe("claude-3-sonnet") // preserved
  })

  test("partial fileAction update preserves unrelated fields", () => {
    let snapshot = createInitialPresenceState()
    // Use normalizeFileIdentity so the stored path matches what the plugin stores
    const filePath = normalizeFileIdentity("./src/app.ts")
    snapshot = presenceReducer(snapshot, updateFileAction({ file: filePath, operation: "Editing" }))
    snapshot = presenceReducer(snapshot, updateFileAction({ operation: "Reading" }))

    expect(snapshot.fileAction.file).toBe("src/app.ts") // preserved
    expect(snapshot.fileAction.operation).toBe("Reading")
  })

  test("multiple sequential updates accumulate correctly", () => {
    let snapshot = createInitialPresenceState()
    let metrics = createSessionMetricsState()

    // Message 1
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude" }))
    metrics = recordMessageActivity(metrics)

    // File touch 1
    const file1 = normalizeFileIdentity("./src/a.ts")
    snapshot = presenceReducer(snapshot, updateFileAction({ file: file1, operation: "Editing" }))
    metrics = recordFileTouch(metrics, file1)

    // Message 2 (agent switch)
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Prometheus" }))
    metrics = recordMessageActivity(metrics)
    metrics = recordTaskContext(metrics, "Implement feature X")

    // File touch 2
    const file2 = normalizeFileIdentity("./src/b.ts")
    snapshot = presenceReducer(snapshot, updateFileAction({ file: file2, operation: "Reading" }))
    metrics = recordFileTouch(metrics, file2)

    expect(snapshot.identity.agent).toBe("Prometheus")
    expect(snapshot.identity.model).toBe("") // never set
    expect(metrics.messageCount).toBe(2)
    expect(metrics.uniqueFilesTouched.size).toBe(2)
    expect(metrics.lastTaskContext).toBe("Implement feature X")
    expect(metrics.lastFileContext).toBe(file2)
  })
})

// ─── primary plugin instance dedup ────────────────────────────────────────────

describe("primary plugin instance dedup", () => {
  test("first claim succeeds, subsequent claims fail until release", () => {
    releasePrimaryPluginInstance()
    expect(isPrimaryPluginInstance()).toBe(true)
    expect(isPrimaryPluginInstance()).toBe(false)
    expect(isPrimaryPluginInstance()).toBe(false)
  })

  test("releasePrimaryPluginInstance allows a fresh claim", () => {
    releasePrimaryPluginInstance()
    isPrimaryPluginInstance()
    releasePrimaryPluginInstance()
    expect(isPrimaryPluginInstance()).toBe(true)
    releasePrimaryPluginInstance()
  })
})

// ─── startPluginAsync (non-blocking init) ─────────────────────────────────────

describe("startPluginAsync — non-blocking init", () => {
  test("returns synchronously without awaiting connect even when Discord is unreachable", () => {
    let connectCalled = false
    let pushCalled = false
    let timerStarted = false

    const mockRpc = {
      isConnected: () => false,
      connect: () => {
        connectCalled = true
        // Never resolves — models @xhayper/discord-rpc's ~10s IPC timeout
        // when Discord desktop is not running.
        return new Promise<boolean>(() => {})
      },
    }

    const start = performance.now()
    startPluginAsync(
      mockRpc as unknown as DiscordRPCService,
      async () => {
        pushCalled = true
      },
      () => {
        timerStarted = true
      },
    )
    const elapsed = performance.now() - start

    // Sync portion MUST complete fast even though connect() is pending forever
    expect(elapsed).toBeLessThan(50)
    expect(timerStarted).toBe(true)
    expect(pushCalled).toBe(true)
    expect(connectCalled).toBe(true)
  })

  test("skips connect when already connected", () => {
    let connectCalled = false

    const mockRpc = {
      isConnected: () => true,
      connect: () => {
        connectCalled = true
        return Promise.resolve(true)
      },
    }

    startPluginAsync(
      mockRpc as unknown as DiscordRPCService,
      async () => {},
      () => {},
    )

    expect(connectCalled).toBe(false)
  })

  test("does not propagate connect() rejections to the caller", () => {
    const mockRpc = {
      isConnected: () => false,
      connect: () => Promise.reject(new Error("boom")),
    }

    expect(() =>
      startPluginAsync(
        mockRpc as unknown as DiscordRPCService,
        async () => {},
        () => {},
      ),
    ).not.toThrow()
  })

  test("F9: does NOT start rotation timer or connect when isOwner returns false", () => {
    let timerStarted = false
    let pushCalled = false
    let connectCalled = false

    const mockRpc = {
      isConnected: () => false,
      connect: () => {
        connectCalled = true
        return Promise.resolve(true)
      },
    }

    startPluginAsync(
      mockRpc as unknown as DiscordRPCService,
      async () => {
        pushCalled = true
      },
      () => {
        timerStarted = true
      },
      () => false,
    )

    expect(timerStarted).toBe(false)
    expect(pushCalled).toBe(false)
    expect(connectCalled).toBe(false)
  })
})

describe("buildInstancesDir", () => {
  test("path includes hostname and clientId subdirectories", () => {
    const result = buildInstancesDir("/home/u", "host-1", "12345")
    expect(result).toBe("/home/u/.opencode-discord-presence/instances/host-1/12345")
  })

  test("sanitizes unsafe characters in hostname and clientId", () => {
    const result = buildInstancesDir("/home/u", "host:with/slashes", "client id!")
    expect(result).toBe("/home/u/.opencode-discord-presence/instances/host_with_slashes/client_id_")
  })

  test("falls back to placeholders when components are empty", () => {
    const result = buildInstancesDir("/home/u", "", "")
    expect(result).toBe("/home/u/.opencode-discord-presence/instances/unknown-host/default")
  })

  test("two different clientIds produce different paths", () => {
    const a = buildInstancesDir("/home/u", "host", "app-a")
    const b = buildInstancesDir("/home/u", "host", "app-b")
    expect(a).not.toBe(b)
  })

  test("two different hostnames produce different paths", () => {
    const a = buildInstancesDir("/home/u", "host-a", "app")
    const b = buildInstancesDir("/home/u", "host-b", "app")
    expect(a).not.toBe(b)
  })
})

describe("createOwnershipHandler", () => {
  type FakeRPC = {
    connect: () => Promise<boolean>
    disconnect: () => Promise<void>
    clear: () => Promise<void>
  }

  function makeRpc(): {
    rpc: FakeRPC
    calls: { connect: number; disconnect: number; clear: number }
  } {
    const calls = { connect: 0, disconnect: 0, clear: 0 }
    const rpc: FakeRPC = {
      connect: () => {
        calls.connect++
        return Promise.resolve(true)
      },
      disconnect: () => {
        calls.disconnect++
        return Promise.resolve()
      },
      clear: () => {
        calls.clear++
        return Promise.resolve()
      },
    }
    return { rpc, calls }
  }

  test("F11: gaining ownership waits for settle window before calling connect", async () => {
    const { rpc, calls } = makeRpc()
    let rotationStarted = 0

    const handler = createOwnershipHandler({
      rpc: rpc as unknown as DiscordRPCService,
      pushPresence: async () => {},
      startRotationTimer: () => {
        rotationStarted++
      },
      stopRotationTimer: () => {},
      isStillOwner: () => true,
      settleMs: 20,
    })

    handler.onOwnership(true)
    expect(calls.connect).toBe(0)
    expect(rotationStarted).toBe(0)

    await new Promise((r) => setTimeout(r, 50))

    expect(calls.connect).toBe(1)
    expect(rotationStarted).toBe(1)
    handler.cancelPending()
  })

  test("F11: ownership lost during settle cancels the pending connect", async () => {
    const { rpc, calls } = makeRpc()

    const handler = createOwnershipHandler({
      rpc: rpc as unknown as DiscordRPCService,
      pushPresence: async () => {},
      startRotationTimer: () => {},
      stopRotationTimer: () => {},
      isStillOwner: () => true,
      settleMs: 30,
    })

    handler.onOwnership(true)
    await new Promise((r) => setTimeout(r, 10))
    handler.onOwnership(false)
    await new Promise((r) => setTimeout(r, 50))

    expect(calls.connect).toBe(0)
    expect(calls.disconnect).toBe(1)
    expect(calls.clear).toBe(1)
  })

  test("F11: losing ownership disconnects and clears immediately (no settle)", async () => {
    const { rpc, calls } = makeRpc()

    const handler = createOwnershipHandler({
      rpc: rpc as unknown as DiscordRPCService,
      pushPresence: async () => {},
      startRotationTimer: () => {},
      stopRotationTimer: () => {},
      isStillOwner: () => true,
      settleMs: 30,
    })

    handler.onOwnership(false)
    expect(calls.disconnect).toBe(1)
    expect(calls.clear).toBe(1)
    expect(calls.connect).toBe(0)
  })

  test("F11: settle re-checks isStillOwner before connecting (avoids stale connect)", async () => {
    const { rpc, calls } = makeRpc()
    let isOwnerNow = true

    const handler = createOwnershipHandler({
      rpc: rpc as unknown as DiscordRPCService,
      pushPresence: async () => {},
      startRotationTimer: () => {},
      stopRotationTimer: () => {},
      isStillOwner: () => isOwnerNow,
      settleMs: 20,
    })

    handler.onOwnership(true)
    isOwnerNow = false
    await new Promise((r) => setTimeout(r, 40))

    expect(calls.connect).toBe(0)
  })

  test("F11: cancelPending() stops a scheduled connect", async () => {
    const { rpc, calls } = makeRpc()

    const handler = createOwnershipHandler({
      rpc: rpc as unknown as DiscordRPCService,
      pushPresence: async () => {},
      startRotationTimer: () => {},
      stopRotationTimer: () => {},
      isStillOwner: () => true,
      settleMs: 30,
    })

    handler.onOwnership(true)
    handler.cancelPending()
    await new Promise((r) => setTimeout(r, 50))

    expect(calls.connect).toBe(0)
  })

  test("default settleMs strictly exceeds coordinator tick interval (handoff race fix)", async () => {
    const { rpc, calls } = makeRpc()
    let connectAt: number | null = null

    const startedAt = Date.now()
    const handler = createOwnershipHandler({
      rpc: {
        ...rpc,
        connect: () => {
          connectAt = Date.now()
          calls.connect++
          return Promise.resolve(true)
        },
      } as unknown as DiscordRPCService,
      pushPresence: async () => {},
      startRotationTimer: () => {},
      stopRotationTimer: () => {},
      isStillOwner: () => true,
    })

    handler.onOwnership(true)
    await new Promise((r) => setTimeout(r, 1500))

    expect(calls.connect).toBe(1)
    expect(connectAt).not.toBeNull()
    const elapsed = (connectAt as unknown as number) - startedAt
    expect(elapsed).toBeGreaterThan(1000)
  })
})

describe("recap reducer clearing contract (oracle P1)", () => {
  test("updateRecapCache({}) on a populated cache does NOT clear timestamp (documents the regression)", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(
      snapshot,
      updateRecapCache({
        messageCount: 27,
        filesTouched: ["a.ts", "b.ts"],
        uniqueFileCount: 2,
        activeDurationSeconds: 3600,
        timestamp: 1_700_000_000_000,
      }),
    )

    snapshot = presenceReducer(snapshot, updateRecapCache({}))

    expect(snapshot.recapCache.timestamp).toBe(1_700_000_000_000)
    expect(snapshot.recapCache.messageCount).toBe(27)
  })

  test("direct snapshot.recapCache reset DOES clear all fields", () => {
    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(
      snapshot,
      updateRecapCache({
        messageCount: 27,
        filesTouched: ["a.ts"],
        uniqueFileCount: 1,
        activeDurationSeconds: 1000,
        timestamp: 1_700_000_000_000,
      }),
    )

    snapshot = { ...snapshot, recapCache: {} }

    expect(snapshot.recapCache.timestamp).toBeUndefined()
    expect(snapshot.recapCache.messageCount).toBeUndefined()
  })

  test("recap-then-activity-within-30s: after reset, getActivity shows new activity, NOT recap", () => {
    const opts: RichPresenceOptions = {
      enableFileSpotlight: true,
      enableMissionBoard: true,
      rotationIntervalSeconds: 20,
      diagnostics: { errorsOnly: true },
      mainAgentOnly: false,
    }

    let snapshot = createInitialPresenceState()
    snapshot = presenceReducer(snapshot, updateIdentity({ agent: "Claude", model: "opus-4-5" }))
    snapshot = presenceReducer(
      snapshot,
      updateRecapCache({
        messageCount: 27,
        filesTouched: ["x.ts"],
        uniqueFileCount: 1,
        activeDurationSeconds: 3600,
        timestamp: Date.now(),
      }),
    )

    expect(getActivity(snapshot, opts, 0).details).toBe("Session Complete!")

    snapshot = { ...snapshot, recapCache: {} }
    snapshot = presenceReducer(
      snapshot,
      updateFileAction({ file: "src/new.ts", action: "edit", operation: "Editing" }),
    )

    const activity = getActivity(snapshot, opts, 0)
    expect(activity.details).not.toBe("Session Complete!")
    expect(activity.details).toContain("Claude")
  })
})

describe("createRecapScheduler", () => {
  function makeScheduler(delayMs: number): {
    scheduler: ReturnType<typeof createRecapScheduler>
    cleared: () => number
  } {
    let cleared = 0
    const scheduler = createRecapScheduler({
      clearRecapState: () => {
        cleared++
      },
      delayMs,
    })
    return { scheduler, cleared: () => cleared }
  }

  test("F10: scheduled clear runs after delay", async () => {
    const { scheduler, cleared } = makeScheduler(20)
    scheduler.schedule()
    expect(cleared()).toBe(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(cleared()).toBe(1)
  })

  test("F10: flushNow runs clear immediately and cancels pending timer", async () => {
    const { scheduler, cleared } = makeScheduler(10_000)
    scheduler.schedule()
    scheduler.flushNow()
    expect(cleared()).toBe(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(cleared()).toBe(1)
  })

  test("F10: cancel clears the timer without running clear", async () => {
    const { scheduler, cleared } = makeScheduler(20)
    scheduler.schedule()
    scheduler.cancel()
    await new Promise((r) => setTimeout(r, 60))
    expect(cleared()).toBe(0)
  })

  test("F10: re-scheduling replaces the previous pending clear", async () => {
    const { scheduler, cleared } = makeScheduler(30)
    scheduler.schedule()
    scheduler.schedule()
    await new Promise((r) => setTimeout(r, 80))
    expect(cleared()).toBe(1)
  })

  test("F10: flushNow without schedule is a no-op", () => {
    const { scheduler, cleared } = makeScheduler(20)
    scheduler.flushNow()
    expect(cleared()).toBe(0)
  })

  test("F10: flushNow after timer already ran does not re-clear", async () => {
    const { scheduler, cleared } = makeScheduler(10)
    scheduler.schedule()
    await new Promise((r) => setTimeout(r, 40))
    expect(cleared()).toBe(1)
    scheduler.flushNow()
    expect(cleared()).toBe(1)
  })
})
