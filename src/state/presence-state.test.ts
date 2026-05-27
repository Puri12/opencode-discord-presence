import { describe, expect, test } from "bun:test"
import {
  createInitialPresenceState,
  presenceReducer,
  updateDiagnosticsSummary,
  updateFileAction,
  updateIdentity,
  updateIdle,
  updateRecapCache,
  updateRotationMetadata,
  updateSessionMetrics,
  updateTodoSummary,
} from "./presence-state"

describe("PresenceSnapshot", () => {
  describe("createInitialPresenceState", () => {
    test("creates a valid initial state with defaults", () => {
      const state = createInitialPresenceState()

      expect(state.identity).toEqual({ agent: "OpenCode", model: "" })
      expect(state.idle).toBe(false)
      expect(state.fileAction).toEqual({})
      expect(state.todoSummary).toEqual({
        total: 0,
        completed: 0,
        pending: 0,
        allDone: false,
      })
      expect(state.diagnosticsSummary).toEqual({
        errors: 0,
        warnings: 0,
        hints: 0,
        infos: 0,
      })
      expect(state.sessionMetrics.messageCount).toBe(0)
      expect(state.sessionMetrics.uniqueFilesTouched.size).toBe(0)
      expect(state.sessionMetrics.agentSwitches).toBe(0)
      expect(state.recapCache).toEqual({})
      expect(state.rotationMetadata).toEqual({})
    })
  })

  describe("presenceReducer", () => {
    test("applies identity update without wiping other state", () => {
      const state = createInitialPresenceState()
      state.diagnosticsSummary = { errors: 5, warnings: 3, hints: 1, infos: 2 }
      state.sessionMetrics.messageCount = 42

      const next = presenceReducer(state, updateIdentity({ agent: "Prometheus", model: "sonnet" }))

      expect(next.identity).toEqual({ agent: "Prometheus", model: "sonnet" })
      expect(next.diagnosticsSummary).toEqual({
        errors: 5,
        warnings: 3,
        hints: 1,
        infos: 2,
      })
      expect(next.sessionMetrics.messageCount).toBe(42)
      expect(next.idle).toBe(false)
    })

    test("applies idle update without wiping other state", () => {
      const state = createInitialPresenceState()
      state.identity = { agent: "Prometheus", model: "sonnet" }
      state.fileAction = { file: "src/index.ts", action: "edit", line: 42 }

      const next = presenceReducer(state, updateIdle(true))

      expect(next.idle).toBe(true)
      expect(next.identity).toEqual({ agent: "Prometheus", model: "sonnet" })
      expect(next.fileAction).toEqual({
        file: "src/index.ts",
        action: "edit",
        line: 42,
      })
    })

    test("applies fileAction partial update without wiping other fields", () => {
      const state = createInitialPresenceState()
      state.fileAction = {
        file: "src/index.ts",
        action: "edit",
        line: 42,
        language: "typescript",
      }

      const next = presenceReducer(state, updateFileAction({ action: "view" }))

      expect(next.fileAction).toEqual({
        file: "src/index.ts",
        action: "view",
        line: 42,
        language: "typescript",
      })
    })

    test("applies todoSummary with allDone and activeTaskLabel", () => {
      const state = createInitialPresenceState()
      state.identity = { agent: "Prometheus", model: "sonnet" }

      const next = presenceReducer(
        state,
        updateTodoSummary({
          total: 5,
          completed: 5,
          pending: 0,
          allDone: true,
          activeTaskLabel: "Complete feature X",
        }),
      )

      expect(next.todoSummary).toEqual({
        total: 5,
        completed: 5,
        pending: 0,
        allDone: true,
        activeTaskLabel: "Complete feature X",
      })
      expect(next.identity).toEqual({ agent: "Prometheus", model: "sonnet" })
    })

    test("applies todoSummary partial update without wiping other state", () => {
      const state = createInitialPresenceState()
      state.identity = { agent: "Prometheus", model: "sonnet" }
      state.diagnosticsSummary = { errors: 5, warnings: 3, hints: 1, infos: 0 }

      const next = presenceReducer(state, updateTodoSummary({ total: 10, completed: 3 }))

      expect(next.todoSummary).toEqual({
        total: 10,
        completed: 3,
        pending: 0,
        allDone: false,
      })
      expect(next.identity).toEqual({ agent: "Prometheus", model: "sonnet" })
      expect(next.diagnosticsSummary).toEqual({
        errors: 5,
        warnings: 3,
        hints: 1,
        infos: 0,
      })
    })

    test("applies diagnosticsSummary partial update without wiping other state", () => {
      const state = createInitialPresenceState()
      state.todoSummary = {
        total: 10,
        completed: 5,
        pending: 5,
        allDone: false,
      }
      state.sessionMetrics.messageCount = 100

      const next = presenceReducer(state, updateDiagnosticsSummary({ errors: 0, warnings: 2 }))

      expect(next.diagnosticsSummary).toEqual({
        errors: 0,
        warnings: 2,
        hints: 0,
        infos: 0,
      })
      expect(next.todoSummary).toEqual({
        total: 10,
        completed: 5,
        pending: 5,
        allDone: false,
      })
      expect(next.sessionMetrics.messageCount).toBe(100)
    })

    test("applies sessionMetrics update without wiping other state", () => {
      const state = createInitialPresenceState()
      state.identity = { agent: "Claude", model: "opus" }
      state.sessionMetrics.uniqueFilesTouched = new Set(["a.ts", "b.ts"])

      const next = presenceReducer(state, updateSessionMetrics({ messageCount: 50, cost: 1.5 }))

      expect(next.sessionMetrics.messageCount).toBe(50)
      expect(next.sessionMetrics.cost).toBe(1.5)
      expect(next.identity).toEqual({ agent: "Claude", model: "opus" })
      expect(next.sessionMetrics.uniqueFilesTouched.size).toBe(2)
    })

    test("sessionMetrics Set merging preserves existing files", () => {
      const state = createInitialPresenceState()
      state.sessionMetrics.uniqueFilesTouched = new Set(["a.ts", "b.ts"])

      const next = presenceReducer(
        state,
        updateSessionMetrics({
          uniqueFilesTouched: new Set(["c.ts", "d.ts"]),
        }),
      )

      expect(next.sessionMetrics.uniqueFilesTouched.size).toBe(4)
      expect(next.sessionMetrics.uniqueFilesTouched.has("a.ts")).toBe(true)
      expect(next.sessionMetrics.uniqueFilesTouched.has("b.ts")).toBe(true)
      expect(next.sessionMetrics.uniqueFilesTouched.has("c.ts")).toBe(true)
      expect(next.sessionMetrics.uniqueFilesTouched.has("d.ts")).toBe(true)
    })

    test("applies recapCache with richer composition fields", () => {
      const state = createInitialPresenceState()
      state.rotationMetadata = { index: 1, total: 3 }

      const next = presenceReducer(
        state,
        updateRecapCache({
          summary: "Worked on feature X",
          timestamp: 1234567890,
          filesTouched: ["a.ts", "b.ts"],
          messageCount: 25,
          completedTasks: ["task1", "task2"],
          pendingTasks: ["task3"],
          keyOutcomes: ["implemented X", "fixed Y"],
        }),
      )

      expect(next.recapCache.summary).toBe("Worked on feature X")
      expect(next.recapCache.filesTouched).toEqual(["a.ts", "b.ts"])
      expect(next.recapCache.messageCount).toBe(25)
      expect(next.recapCache.completedTasks).toEqual(["task1", "task2"])
      expect(next.recapCache.pendingTasks).toEqual(["task3"])
      expect(next.recapCache.keyOutcomes).toEqual(["implemented X", "fixed Y"])
      expect(next.rotationMetadata).toEqual({ index: 1, total: 3 })
    })

    test("applies rotationMetadata partial update without wiping other state", () => {
      const state = createInitialPresenceState()
      state.recapCache = { summary: "Previous recap" }

      const next = presenceReducer(
        state,
        updateRotationMetadata({
          index: 2,
          total: 5,
          strategy: "round-robin",
          lastRotationTimestamp: 1234567890,
        }),
      )

      expect(next.rotationMetadata).toEqual({
        index: 2,
        total: 5,
        strategy: "round-robin",
        lastRotationTimestamp: 1234567890,
      })
      expect(next.recapCache).toEqual({ summary: "Previous recap" })
    })

    test("applies batch update sequentially without wiping state between updates", () => {
      const state = createInitialPresenceState()

      const next = presenceReducer(state, {
        type: "batch",
        payload: [
          updateIdentity({ agent: "Prometheus", model: "sonnet" }),
          updateIdle(true),
          updateFileAction({
            file: "src/plugin.ts",
            action: "edit",
            language: "typescript",
          }),
          updateTodoSummary({
            total: 5,
            completed: 2,
            pending: 3,
            allDone: false,
            activeTaskLabel: "Fix bug",
          }),
          updateDiagnosticsSummary({
            errors: 1,
            warnings: 0,
            hints: 0,
            infos: 0,
          }),
          updateSessionMetrics({ messageCount: 10 }),
        ],
      })

      expect(next.identity).toEqual({ agent: "Prometheus", model: "sonnet" })
      expect(next.idle).toBe(true)
      expect(next.fileAction).toEqual({
        file: "src/plugin.ts",
        action: "edit",
        language: "typescript",
      })
      expect(next.todoSummary).toEqual({
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Fix bug",
      })
      expect(next.diagnosticsSummary).toEqual({
        errors: 1,
        warnings: 0,
        hints: 0,
        infos: 0,
      })
      expect(next.sessionMetrics.messageCount).toBe(10)
      expect(next.recapCache).toEqual({})
      expect(next.rotationMetadata).toEqual({})
    })

    test("returns same state for unknown update type", () => {
      const state = createInitialPresenceState()
      state.identity = { agent: "Test", model: "test" }

      // @ts-expect-error - testing unknown type at runtime
      const next = presenceReducer(state, { type: "unknown", payload: {} })

      expect(next).toBe(state)
    })
  })

  describe("update helpers", () => {
    test("updateIdentity creates correct update structure", () => {
      const update = updateIdentity({ agent: "Claude" })
      expect(update).toEqual({
        type: "identity",
        payload: { agent: "Claude" },
      })
    })

    test("updateIdle creates correct update structure", () => {
      const update = updateIdle(true)
      expect(update).toEqual({ type: "idle", payload: true })
    })

    test("updateFileAction creates correct update structure", () => {
      const update = updateFileAction({
        file: "test.ts",
        language: "typescript",
      })
      expect(update).toEqual({
        type: "fileAction",
        payload: { file: "test.ts", language: "typescript" },
      })
    })

    test("updateTodoSummary creates correct update structure", () => {
      const update = updateTodoSummary({
        completed: 5,
        allDone: true,
        activeTaskLabel: "Done",
      })
      expect(update).toEqual({
        type: "todoSummary",
        payload: { completed: 5, allDone: true, activeTaskLabel: "Done" },
      })
    })

    test("updateDiagnosticsSummary creates correct update structure", () => {
      const update = updateDiagnosticsSummary({ errors: 3, infos: 5 })
      expect(update).toEqual({
        type: "diagnosticsSummary",
        payload: { errors: 3, infos: 5 },
      })
    })

    test("updateSessionMetrics creates correct update structure", () => {
      const update = updateSessionMetrics({
        messageCount: 100,
        agentSwitches: 2,
      })
      expect(update).toEqual({
        type: "sessionMetrics",
        payload: { messageCount: 100, agentSwitches: 2 },
      })
    })

    test("updateRecapCache creates correct update structure", () => {
      const update = updateRecapCache({
        summary: "test",
        filesTouched: ["a.ts"],
        completedTasks: ["task1"],
      })
      expect(update).toEqual({
        type: "recapCache",
        payload: {
          summary: "test",
          filesTouched: ["a.ts"],
          completedTasks: ["task1"],
        },
      })
    })

    test("updateRotationMetadata creates correct update structure", () => {
      const update = updateRotationMetadata({
        index: 1,
        lastRotationTimestamp: 123,
      })
      expect(update).toEqual({
        type: "rotationMetadata",
        payload: { index: 1, lastRotationTimestamp: 123 },
      })
    })
  })
})
