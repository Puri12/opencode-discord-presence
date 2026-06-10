import { describe, expect, test } from "bun:test"
import type { PresenceSnapshot } from "../state/presence-state"
import { createInitialPresenceState } from "../state/presence-state"
import type { RichPresenceOptions } from "../types/index.js"
import { buildRotatingCards, getActivity, resolveRotatingCard } from "./activity-rotation"

function makeState(overrides: Partial<PresenceSnapshot> = {}): PresenceSnapshot {
  const base = createInitialPresenceState()
  return {
    ...base,
    identity: { agent: "Claude", model: "claude-sonnet-4-20250501" },
    sessionMetrics: {
      ...base.sessionMetrics,
      messageCount: 10,
      uniqueFilesTouched: new Set(["src/plugin.ts", "src/utils/file-label.ts"]),
      activeDurationSeconds: 3600,
      lastActivityTimestamp: Date.now(),
    },
    ...overrides,
  }
}

function defaultOpts(): RichPresenceOptions {
  return {
    enableFileSpotlight: true,
    enableMissionBoard: true,
    rotationIntervalSeconds: 20,
    diagnostics: { errorsOnly: true },
    mainAgentOnly: false,
  }
}

describe("getActivity — precedence", () => {
  test("recap pins over diagnostics, idle, and all-done", () => {
    const state = makeState({
      recapCache: {
        messageCount: 5,
        uniqueFileCount: 3,
        activeDurationSeconds: 600,
        timestamp: Date.now(),
      },
      diagnosticsSummary: { errors: 3, warnings: 1, hints: 0, infos: 0 },
      idle: true,
      todoSummary: { total: 5, completed: 5, pending: 0, allDone: true },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toContain("Session Complete")
  })

  test("diagnostics-error pins over idle and all-done when errors > 0", () => {
    const state = makeState({
      recapCache: {},
      diagnosticsSummary: { errors: 2, warnings: 5, hints: 0, infos: 0 },
      idle: true,
      todoSummary: { total: 5, completed: 5, pending: 0, allDone: true },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toContain("Working with Claude")
    expect(activity.state).toMatch(/\d+ errors?/)
  })

  test("idle pins over all-done", () => {
    const state = makeState({
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      idle: true,
      todoSummary: { total: 5, completed: 5, pending: 0, allDone: true },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toContain("Claude is idle")
  })

  test("idle does not fall back to session duration context", () => {
    const state = makeState({
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      idle: true,
      fileAction: {},
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
      sessionMetrics: {
        ...makeState().sessionMetrics,
        sessionStartTimestamp: Date.now() - 60_000,
        activeDurationSeconds: 60,
      },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toBe("Claude is idle")
    expect(activity.state).toBeUndefined()
  })

  test("all-done pins over file/task rotation", () => {
    const state = makeState({
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      idle: false,
      todoSummary: { total: 3, completed: 3, pending: 0, allDone: true },
      fileAction: { file: "src/utils/activity-rotation.ts", action: "edit" },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toContain("All tasks complete")
  })

  test("warnings alone do NOT pin — they stay in rotation", () => {
    const state = makeState({
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 5, hints: 0, infos: 0 },
      idle: false,
      todoSummary: { total: 3, completed: 1, pending: 2, allDone: false },
      fileAction: {
        file: "D:/coding_clone/opencode-discord-presence/src/utils/activity-rotation.ts",
        action: "edit",
      },
    })

    const activity = getActivity(state, defaultOpts())

    // Should NOT be diagnostics pinned — errors is 0
    expect(activity.state).not.toMatch(/\d+ errors?/)
    // Should be the rotating file card showing the file
    expect(activity.state).toContain("activity-rotation.ts")
  })
})

describe("getActivity — rotation (no critical state)", () => {
  function makeRotatingState(
    fileAction?: { file: string; action: string; operation?: string },
    todoSummary?: Partial<PresenceSnapshot["todoSummary"]>,
    diagnosticsSummary: PresenceSnapshot["diagnosticsSummary"] = {
      errors: 0,
      warnings: 0,
      hints: 0,
      infos: 0,
    },
  ) {
    return makeState({
      recapCache: {},
      diagnosticsSummary,
      idle: false,
      todoSummary: {
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        ...todoSummary,
      },
      fileAction: fileAction ?? { file: "src/plugin.ts", action: "edit" },
    })
  }

  test("rotates file → task → stats in order on successive ticks (no warnings)", () => {
    const state = makeRotatingState(
      {
        file: "D:/coding_clone/opencode-discord-presence/src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
      },
      {
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Implement rotation",
      },
      { errors: 0, warnings: 0, hints: 0, infos: 0 },
    )
    const opts = defaultOpts()

    // index 0 → file spotlight
    const act0 = getActivity(state, opts, 0)
    expect(act0.details).toContain("Working with Claude")
    expect(act0.state).toContain("activity-rotation.ts")

    // index 1 → task mission board
    const act1 = getActivity(state, opts, 1)
    expect(act1.details).toContain("Working with Claude")
    expect(act1.state).toMatch(/Implement rotation/)

    // index 2 → session stats
    const act2 = getActivity(state, opts, 2)
    expect(act2.details).toContain("Working with Claude")
    expect(act2.state).toMatch(/\d+ prompts/)
  })

  test("warnings-only rotates: file → task → warnings → stats (4 cards)", () => {
    const state = makeRotatingState(
      {
        file: "D:/coding_clone/opencode-discord-presence/src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
      },
      {
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Implement rotation",
      },
      { errors: 0, warnings: 3, hints: 0, infos: 0 },
    )
    const opts = defaultOpts()

    // index 0 → file
    const act0 = getActivity(state, opts, 0)
    expect(act0.state).toContain("activity-rotation.ts")

    // index 1 → task
    const act1 = getActivity(state, opts, 1)
    expect(act1.state).toMatch(/Implement rotation/)

    // index 2 → warnings card (only when warnings > 0 && errors === 0)
    const act2 = getActivity(state, opts, 2)
    expect(act2.details).toContain("Working with Claude")
    expect(act2.state).toMatch(/3 warnings/)
    expect(act2.details).toContain("Working with Claude")

    // index 3 → stats
    const act3 = getActivity(state, opts, 3)
    expect(act3.state).toMatch(/\d+ prompts/)
  })

  test("warnings card does NOT appear when errors > 0 (diagnostics pins instead)", () => {
    const state = makeRotatingState(
      {
        file: "D:/coding_clone/opencode-discord-presence/src/utils/activity-rotation.ts",
        action: "edit",
      },
      {
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Implement rotation",
      },
      { errors: 2, warnings: 3, hints: 0, infos: 0 },
    )
    const opts = defaultOpts()

    // Even at rotation index 2 (which would be warnings if it were active),
    // diagnostics-error takes precedence since errors > 0
    const act2 = getActivity(state, opts, 2)
    expect(act2.state).toMatch(/\d+ errors?/)
    expect(act2.details).toContain("Working with Claude")
  })

  test("file spotlight disabled → skips to task or stats (or warnings)", () => {
    const state = makeRotatingState(
      {
        file: "D:/coding_clone/opencode-discord-presence/src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
      },
      {
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Implement rotation",
      },
      { errors: 0, warnings: 2, hints: 0, infos: 0 },
    )
    const opts = { ...defaultOpts(), enableFileSpotlight: false }

    // index 0 → task (file disabled)
    const act0 = getActivity(state, opts, 0)
    expect(act0.state).toMatch(/Implement rotation/)

    // index 1 → warnings (file disabled, task→warnings→stats)
    const act1 = getActivity(state, opts, 1)
    expect(act1.state).toMatch(/2 warnings/)

    // index 2 → stats
    const act2 = getActivity(state, opts, 2)
    expect(act2.state).toMatch(/\d+ prompts/)
  })

  test("mission board disabled → file → stats (warnings still rotates if applicable)", () => {
    const state = makeRotatingState(
      {
        file: "D:/coding_clone/opencode-discord-presence/src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
      },
      { total: 0, completed: 0, pending: 0, allDone: false },
      { errors: 0, warnings: 2, hints: 0, infos: 0 },
    )
    const opts = { ...defaultOpts(), enableMissionBoard: false }

    // index 0 → file
    const act0 = getActivity(state, opts, 0)
    expect(act0.state).toContain("activity-rotation.ts")

    // index 1 → warnings
    const act1 = getActivity(state, opts, 1)
    expect(act1.state).toMatch(/2 warnings/)

    // index 2 → stats
    const act2 = getActivity(state, opts, 2)
    expect(act2.state).toMatch(/\d+ prompts/)
  })

  test("both file and mission disabled → warnings → stats", () => {
    const state = makeRotatingState(
      { file: "src/utils/activity-rotation.ts", action: "edit" },
      { total: 0, completed: 0, pending: 0, allDone: false },
      { errors: 0, warnings: 4, hints: 0, infos: 0 },
    )
    const opts = {
      ...defaultOpts(),
      enableFileSpotlight: false,
      enableMissionBoard: false,
    }

    // index 0 → warnings
    const act0 = getActivity(state, opts, 0)
    expect(act0.state).toMatch(/4 warnings/)

    // index 1 → stats
    const act1 = getActivity(state, opts, 1)
    expect(act1.state).toMatch(/\d+ prompts/)
  })

  test("wraps rotation index back to 0 after last card", () => {
    const state = makeRotatingState(
      {
        file: "src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
      },
      {
        total: 5,
        completed: 2,
        pending: 3,
        allDone: false,
        activeTaskLabel: "Implement rotation",
      },
      { errors: 0, warnings: 0, hints: 0, infos: 0 },
    )
    const opts = defaultOpts()

    const act0 = getActivity(state, opts, 0)
    const act3 = getActivity(state, opts, 3) // wraps to 0

    expect(act0.state).toBe(act3.state)
  })
})

describe("getActivity — operation-specific file spotlight details", () => {
  const baseOpts = defaultOpts()

  test("editing uses plain working details", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    expect(activity.details).toBe("Working with Claude")
  })

  test("reading uses plain working details", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "read",
        operation: "Reading",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    expect(activity.details).toBe("Working with Claude")
  })

  test("searching uses plain working details", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "grep",
        operation: "Searching",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    expect(activity.details).toBe("Working with Claude")
  })

  test("running tests uses plain working details", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "bash",
        operation: "Running tests",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    expect(activity.details).toBe("Working with Claude")
  })

  test("building uses plain working details", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "bash",
        operation: "Building",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    expect(activity.details).toBe("Working with Claude")
  })

  test("diagnosing uses plain working details", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "diagnose",
        operation: "Diagnosing",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    expect(activity.details).toBe("Working with Claude")
  })

  test("operation falls back to getToolLabel when operation is not explicitly set", () => {
    // When fileAction.operation is absent, getToolLabel is called with eventName derived from action
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "read" /* no operation */,
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, baseOpts, 0)
    // getToolLabel({ eventName: "tool.execute.read" }) → "Reading"
    expect(activity.details).toBe("Working with Claude")
  })
})

describe("getActivity — file-icons integration", () => {
  test("file spotlight uses getFileIconKey for language-based icons", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "src/utils/activity-rotation.ts",
        action: "edit",
        operation: "Editing",
        language: "typescript",
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, defaultOpts(), 0)
    // getFileIconKey("src/utils/activity-rotation.ts", "typescript") → "typescript"
    expect(activity.assets?.largeImageKey).toBe("typescript")
  })

  test("file spotlight falls back to extension-based icon", () => {
    const state = makeState({
      idle: false,
      fileAction: {
        file: "README.md",
        action: "read",
        operation: "Reading",
        // no language — should use extension map
      },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, defaultOpts(), 0)
    // getFileIconKey("README.md") → "markdown"
    expect(activity.assets?.largeImageKey).toBe("markdown")
  })
})

describe("getActivity — headline preservation", () => {
  test("idle headline uses plain idle style", () => {
    const state = makeState({
      idle: true,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toBe("Claude is idle")
  })

  test("session recap uses dedicated 'Session Complete!' headline", () => {
    const state = makeState({
      recapCache: {
        messageCount: 27,
        uniqueFileCount: 3,
        activeDurationSeconds: 3720,
        timestamp: Date.now(),
      },
      idle: false,
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toBe("Session Complete!")
  })

  test("all-done uses dedicated 'All tasks complete!' headline", () => {
    const state = makeState({
      idle: false,
      todoSummary: { total: 5, completed: 5, pending: 0, allDone: true },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
    })

    const activity = getActivity(state, defaultOpts())

    expect(activity.details).toBe("All tasks complete!")
  })
})

describe("getActivity — Korean localization", () => {
  const koOpts = defaultOpts()

  test("Korean idle produces localized idle string", () => {
    const state = makeState({
      identity: { agent: "클라우드", model: "claude-sonnet-4-20250501" },
      idle: true,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, koOpts, 0, "ko")

    // Korean idle with "클라우드" agent — particle applied
    expect(activity.details).toContain("휴식중")
    expect(activity.state).toBeUndefined()
  })

  test("Korean working (file spotlight) produces localized working string", () => {
    const state = makeState({
      identity: { agent: "아르토", model: "gpt-4o" },
      idle: false,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
      fileAction: {
        file: "src/plugin.ts",
        action: "edit",
        operation: "Editing",
      },
    })

    const activity = getActivity(state, koOpts, 0, "ko")

    // Korean working for "아르토" — particle applied
    expect(activity.details).toContain("작업중")
    expect(activity.state).toContain("plugin.ts")
  })

  test("Korean task mission board produces localized working string", () => {
    const state = makeState({
      identity: { agent: "클라우드", model: "claude-sonnet-4-20250501" },
      idle: false,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: {
        total: 3,
        completed: 1,
        pending: 2,
        allDone: false,
        activeTaskLabel: "Implement dark mode",
      },
      fileAction: {},
    })

    const activity = getActivity(state, koOpts, 1, "ko")

    expect(activity.details).toContain("작업중")
    expect(activity.state).toMatch(/Implement dark mode/)
  })

  test("Korean session stats fallback produces localized working string", () => {
    const state = makeState({
      identity: { agent: "아르토", model: "gpt-4o" },
      idle: false,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
      fileAction: {},
    })

    const activity = getActivity(state, koOpts, 2, "ko")

    expect(activity.details).toContain("작업중")
    expect(activity.state).toBe("gpt-4o • 10개 프롬프트 • 2개 파일")
  })

  test("Korean session recap localizes headline and stats line", () => {
    const state = makeState({
      identity: { agent: "클라우드", model: "claude-sonnet-4-20250501" },
      recapCache: {
        messageCount: 27,
        uniqueFileCount: 3,
        filesTouched: ["src/plugin.ts", "src/utils/file-label.ts", "README.ko.md"],
        activeDurationSeconds: 3720,
        timestamp: Date.now(),
      },
      idle: false,
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
    })

    const activity = getActivity(state, koOpts, 0, "ko")

    expect(activity.details).toBe("세션 완료!")
    expect(activity.state).toBe("27개 프롬프트 • 3개 파일")
  })

  test("Korean diagnostics error localizes headline and state", () => {
    const state = makeState({
      identity: { agent: "클라우드", model: "claude-sonnet-4-20250501" },
      idle: false,
      recapCache: {},
      diagnosticsSummary: { errors: 2, warnings: 1, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, koOpts, 0, "ko")

    expect(activity.details).toBe("클라우드를 작업중")
    expect(activity.state).toBe("claude-sonnet-4-20250501 • 오류 2개, 경고 1개")
  })

  test("Korean all tasks complete localizes headline and state", () => {
    const state = makeState({
      identity: { agent: "클라우드", model: "claude-sonnet-4-20250501" },
      idle: false,
      todoSummary: { total: 5, completed: 5, pending: 0, allDone: true },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
    })

    const activity = getActivity(state, koOpts, 0, "ko")

    expect(activity.details).toBe("모든 작업 완료!")
    expect(activity.state).toBe("claude-sonnet-4-20250501 • 5/5 완료")
  })

  test("Korean diagnostics warnings localizes state", () => {
    const warningsOnlyOpts: RichPresenceOptions = {
      ...koOpts,
      enableFileSpotlight: false,
      enableMissionBoard: false,
    }

    const state = makeState({
      identity: { agent: "클라우드", model: "claude-sonnet-4-20250501" },
      idle: false,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 2, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
      fileAction: {},
    })

    const activity = getActivity(state, warningsOnlyOpts, 0, "ko")

    expect(activity.details).toBe("클라우드를 작업중")
    expect(activity.state).toBe("claude-sonnet-4-20250501 • 경고 2개")
  })

  test("English locale still works after Korean locale is introduced", () => {
    const state = makeState({
      identity: { agent: "Claude", model: "claude-sonnet-4-20250501" },
      idle: true,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const enActivity = getActivity(state, koOpts, 0, "en")
    const koActivity = getActivity(state, koOpts, 0, "ko")

    expect(enActivity.details).toBe("Claude is idle")
    // Non-Korean name: hasFinalConsonant returns false → topic "는"
    expect(koActivity.details).toBe("Claude는 휴식중")
  })
})

describe("getActivity — truncation safety", () => {
  test("long file labels are truncated before being placed in state", () => {
    const veryLongPath = `D:/coding_clone/opencode-discord-presence/src/features/presence/components/activity-rotation.test.ts`
    const state = makeState({
      idle: false,
      fileAction: { file: veryLongPath, action: "edit", operation: "Editing" },
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
    })

    const activity = getActivity(state, defaultOpts(), 0)

    // State line must stay under Discord's 126-char limit enforced by discord-rpc.ts
    expect(activity.state?.length ?? 0).toBeLessThanOrEqual(126)
  })
})

describe("resolveRotatingCard", () => {
  const opts: RichPresenceOptions = {
    enableFileSpotlight: true,
    enableMissionBoard: true,
    rotationIntervalSeconds: 20,
    diagnostics: { errorsOnly: true },
    mainAgentOnly: false,
  }

  test("returns file-spotlight, task, session-stats in order when no warnings", () => {
    expect(resolveRotatingCard(0, opts, false, 0)).toBe("file-spotlight")
    expect(resolveRotatingCard(1, opts, false, 0)).toBe("task-mission-board")
    expect(resolveRotatingCard(2, opts, false, 0)).toBe("session-stats")
    expect(resolveRotatingCard(3, opts, false, 0)).toBe("file-spotlight") // wraps
  })

  test("includes diagnostics-warnings card when warnings > 0 && errors = 0", () => {
    // Order: file-spotlight → task-mission-board → diagnostics-warnings → session-stats
    expect(resolveRotatingCard(0, opts, true, 0)).toBe("file-spotlight")
    expect(resolveRotatingCard(1, opts, true, 0)).toBe("task-mission-board")
    expect(resolveRotatingCard(2, opts, true, 0)).toBe("diagnostics-warnings")
    expect(resolveRotatingCard(3, opts, true, 0)).toBe("session-stats")
    expect(resolveRotatingCard(4, opts, true, 0)).toBe("file-spotlight") // wraps
  })

  test("excludes diagnostics-warnings when errors > 0 (diagnostics pins instead)", () => {
    // Even though hasWarnings=true, errors>0 means diagnostics pins — warnings card excluded
    expect(resolveRotatingCard(0, opts, true, 2)).toBe("file-spotlight")
    expect(resolveRotatingCard(1, opts, true, 2)).toBe("task-mission-board")
    expect(resolveRotatingCard(2, opts, true, 2)).toBe("session-stats") // no warnings card
  })

  test("excludes diagnostics-warnings when hasWarnings=false", () => {
    expect(resolveRotatingCard(0, opts, false, 0)).toBe("file-spotlight")
    expect(resolveRotatingCard(1, opts, false, 0)).toBe("task-mission-board")
    expect(resolveRotatingCard(2, opts, false, 0)).toBe("session-stats") // no warnings card
  })

  test("file disabled → task → warnings → stats", () => {
    const optsNoFile: RichPresenceOptions = {
      ...opts,
      enableFileSpotlight: false,
    }
    expect(resolveRotatingCard(0, optsNoFile, true, 0)).toBe("task-mission-board")
    expect(resolveRotatingCard(1, optsNoFile, true, 0)).toBe("diagnostics-warnings")
    expect(resolveRotatingCard(2, optsNoFile, true, 0)).toBe("session-stats")
  })

  test("both disabled → warnings → stats (warnings still rotates)", () => {
    const optsNone: RichPresenceOptions = {
      ...opts,
      enableFileSpotlight: false,
      enableMissionBoard: false,
    }
    // Warnings card still appears since it precedes stats in rotation order
    expect(resolveRotatingCard(0, optsNone, true, 0)).toBe("diagnostics-warnings")
    expect(resolveRotatingCard(1, optsNone, true, 0)).toBe("session-stats")
  })
})

describe("getActivity — model name visibility", () => {
  const MODEL = "claude-opus-4-7"

  function stateWith(model: string | undefined, overrides: Partial<PresenceSnapshot> = {}) {
    return makeState({
      identity: { agent: "Claude", model: model ?? "" },
      idle: false,
      recapCache: {},
      diagnosticsSummary: { errors: 0, warnings: 0, hints: 0, infos: 0 },
      todoSummary: { total: 0, completed: 0, pending: 0, allDone: false },
      fileAction: {},
      ...overrides,
    })
  }

  test("session-stats card prefixes model in state line", () => {
    const activity = getActivity(stateWith(MODEL), defaultOpts(), 2)
    expect(activity.state).toBe(`${MODEL} • 10 prompts • 2 files`)
  })

  test("file-spotlight card prefixes model in state line", () => {
    const activity = getActivity(
      stateWith(MODEL, { fileAction: { file: "src/plugin.ts", action: "edit" } }),
      defaultOpts(),
      0,
    )
    expect(activity.state).toBe(`${MODEL} • plugin.ts`)
  })

  test("mission-board card prefixes model in state line", () => {
    const activity = getActivity(
      stateWith(MODEL, {
        todoSummary: {
          total: 5,
          completed: 2,
          pending: 3,
          allDone: false,
          activeTaskLabel: "Implement X",
        },
      }),
      defaultOpts(),
      1,
    )
    expect(activity.state).toBe(`${MODEL} • Implement X (2/5)`)
  })

  test("diagnostics-error pin prefixes model in state line", () => {
    const activity = getActivity(
      stateWith(MODEL, {
        diagnosticsSummary: { errors: 3, warnings: 1, hints: 0, infos: 0 },
      }),
      defaultOpts(),
      0,
    )
    expect(activity.state).toBe(`${MODEL} • 3 errors, 1 warning`)
  })

  test("diagnostics-warnings card prefixes model in state line", () => {
    const activity = getActivity(
      stateWith(MODEL, {
        diagnosticsSummary: { errors: 0, warnings: 4, hints: 0, infos: 0 },
      }),
      { ...defaultOpts(), enableFileSpotlight: false, enableMissionBoard: false },
      0,
    )
    expect(activity.state).toBe(`${MODEL} • 4 warnings`)
  })

  test("all-tasks-complete pin prefixes model in state line", () => {
    const activity = getActivity(
      stateWith(MODEL, {
        todoSummary: { total: 5, completed: 5, pending: 0, allDone: true },
      }),
      defaultOpts(),
      0,
    )
    expect(activity.state).toBe(`${MODEL} • 5/5 finished`)
  })

  test("idle state OMITS model — current model not relevant when idle", () => {
    const activity = getActivity(stateWith(MODEL, { idle: true }), defaultOpts(), 0)
    expect(activity.state).toBeUndefined()
  })

  test("session-recap OMITS model — historical card, current model irrelevant", () => {
    const activity = getActivity(
      stateWith(MODEL, {
        recapCache: {
          messageCount: 27,
          filesTouched: ["a.ts", "b.ts", "c.ts"],
          timestamp: Date.now(),
        },
      }),
      defaultOpts(),
      0,
    )
    expect(activity.state).not.toContain(MODEL)
    expect(activity.state).toBe("27 prompts • 3 files")
  })

  test("missing model produces no prefix (graceful fallback)", () => {
    const activity = getActivity(stateWith(""), defaultOpts(), 2)
    expect(activity.state).toBe("10 prompts • 2 files")
  })

  test("missing model on file spotlight produces no prefix", () => {
    const activity = getActivity(
      stateWith("", { fileAction: { file: "src/plugin.ts", action: "edit" } }),
      defaultOpts(),
      0,
    )
    expect(activity.state).toBe("plugin.ts")
  })

  test("Korean rendering preserves model prefix", () => {
    const activity = getActivity(stateWith(MODEL), defaultOpts(), 2, "ko")
    expect(activity.state).toBe(`${MODEL} • 10개 프롬프트 • 2개 파일`)
  })

  test("largeImageText on session-stats card includes model", () => {
    const activity = getActivity(stateWith(MODEL), defaultOpts(), 2)
    expect(activity.assets?.largeImageText).toBe(`Session Stats — ${MODEL}`)
  })

  test("largeImageText on session-stats card falls back to plain label when no model", () => {
    const activity = getActivity(stateWith(""), defaultOpts(), 2)
    expect(activity.assets?.largeImageText).toBe("Session Stats")
  })
})

describe("buildRotatingCards — single source of truth for card set", () => {
  test("default options yield mission-board + session-stats", () => {
    const opts = { ...defaultOpts(), enableFileSpotlight: false }
    expect(buildRotatingCards(opts, false, 0)).toEqual(["task-mission-board", "session-stats"])
  })

  test("all features on with warnings yields all four cards", () => {
    expect(buildRotatingCards(defaultOpts(), true, 0)).toEqual([
      "file-spotlight",
      "task-mission-board",
      "diagnostics-warnings",
      "session-stats",
    ])
  })

  test("warnings card excluded when errors present", () => {
    expect(buildRotatingCards(defaultOpts(), true, 2)).not.toContain("diagnostics-warnings")
  })

  test("everything disabled still yields session-stats fallback (length >= 1)", () => {
    const opts = { ...defaultOpts(), enableFileSpotlight: false, enableMissionBoard: false }
    expect(buildRotatingCards(opts, false, 0)).toEqual(["session-stats"])
  })

  test("resolveRotatingCard agrees with buildRotatingCards across permutations", () => {
    const bools = [true, false]
    const permutations = bools.flatMap((spotlight) =>
      bools.flatMap((board) =>
        bools.flatMap((hasWarnings) =>
          [0, 3].map((errors) => ({ spotlight, board, hasWarnings, errors })),
        ),
      ),
    )

    for (const { spotlight, board, hasWarnings, errors } of permutations) {
      const opts = {
        ...defaultOpts(),
        enableFileSpotlight: spotlight,
        enableMissionBoard: board,
      }
      const cards = buildRotatingCards(opts, hasWarnings, errors)
      expect(cards.length).toBeGreaterThanOrEqual(1)
      for (let i = 0; i < cards.length * 2; i++) {
        expect(resolveRotatingCard(i, opts, hasWarnings, errors)).toBe(cards[i % cards.length])
      }
    }
  })
})
