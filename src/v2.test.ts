import { describe, expect, test } from "bun:test"
import { createClientShim, extractTodosFromToolInput, PLUGIN_ID, translateV2Event } from "./v2.js"

// ─── translateV2Event ─────────────────────────────────────────────────────────

describe("translateV2Event", () => {
  test("maps session.created to the V1 session.created shape", () => {
    const result = translateV2Event({
      type: "session.created",
      data: { sessionID: "ses_1", parentID: "ses_parent" },
    })
    expect(result).toEqual({
      type: "session.created",
      properties: { info: { id: "ses_1", parentID: "ses_parent" } },
    })
  })

  test("maps session.deleted to the V1 session.deleted shape", () => {
    const result = translateV2Event({ type: "session.deleted", data: { sessionID: "ses_1" } })
    expect(result).toEqual({
      type: "session.deleted",
      properties: { info: { id: "ses_1" } },
    })
  })

  test("maps session.status preserving the status union", () => {
    const result = translateV2Event({
      type: "session.status",
      data: { sessionID: "ses_1", status: { type: "busy" } },
    })
    expect(result).toEqual({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    })
  })

  test("maps session.idle to the V1 idle handler", () => {
    const result = translateV2Event({ type: "session.idle", data: { sessionID: "ses_1" } })
    expect(result).toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } })
  })

  test("maps session.execution.started to a busy session.status", () => {
    const result = translateV2Event({
      type: "session.execution.started",
      data: { sessionID: "ses_1" },
    })
    expect(result).toEqual({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    })
  })

  test("maps terminal execution outcomes to the V1 idle handler", () => {
    for (const type of [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]) {
      const result = translateV2Event({ type, data: { sessionID: "ses_1" } })
      expect(result).toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } })
    }
  })

  test("maps file.edited to the V1 file.edited shape", () => {
    const result = translateV2Event({ type: "file.edited", data: { file: "src/a.ts" } })
    expect(result).toEqual({ type: "file.edited", properties: { file: "src/a.ts" } })
  })

  test("maps lsp.updated to the V1 diagnostics event", () => {
    const result = translateV2Event({ type: "lsp.updated", data: {} })
    expect(result).toEqual({ type: "lsp.client.diagnostics", properties: {} })
  })

  test("returns null for unhandled event types", () => {
    expect(
      translateV2Event({ type: "session.text.delta", data: { sessionID: "ses_1" } }),
    ).toBeNull()
    expect(
      translateV2Event({ type: "session.tool.called", data: { sessionID: "ses_1" } }),
    ).toBeNull()
  })

  test("tolerates a missing data payload", () => {
    const result = translateV2Event({ type: "session.idle" })
    expect(result).toEqual({ type: "session.idle", properties: { sessionID: undefined } })
  })
})

// ─── extractTodosFromToolInput ────────────────────────────────────────────────

describe("extractTodosFromToolInput", () => {
  test("returns the todos array from a todo tool input", () => {
    const todos = [{ content: "Task 1", status: "pending" }]
    expect(extractTodosFromToolInput({ todos })).toEqual(todos)
  })

  test("returns undefined when todos is absent or not an array", () => {
    expect(extractTodosFromToolInput({})).toBeUndefined()
    expect(extractTodosFromToolInput({ todos: "nope" })).toBeUndefined()
    expect(extractTodosFromToolInput(undefined)).toBeUndefined()
    expect(extractTodosFromToolInput(null)).toBeUndefined()
  })
})

// ─── createClientShim ─────────────────────────────────────────────────────────

describe("createClientShim", () => {
  test("session.get forwards to ctx.session.get and wraps the response", async () => {
    const calls: string[] = []
    const ctx = {
      location: { directory: "/tmp" },
      session: {
        get: async (input: { sessionID: string }) => {
          calls.push(input.sessionID)
          return { id: input.sessionID, parentID: "parent" }
        },
        hook: async () => ({ dispose: async () => {} }),
      },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    } as never

    const client = createClientShim(ctx)
    const response = await client.session.get({ path: { id: "ses_1" } })

    expect(calls).toEqual(["ses_1"])
    expect((response as { data: { id: string } }).data.id).toBe("ses_1")
  })

  test("session.get rejects without a session id", async () => {
    const ctx = {
      location: { directory: "/tmp" },
      session: { get: async () => ({ id: "x" }), hook: async () => ({ dispose: async () => {} }) },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    } as never

    const client = createClientShim(ctx)
    await expect(client.session.get({})).rejects.toThrow()
  })

  test("app.log is silent unless debug is enabled", async () => {
    const ctx = {
      location: { directory: "/tmp" },
      session: { get: async () => ({}), hook: async () => ({ dispose: async () => {} }) },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    } as never

    const silent = createClientShim(ctx)
    await expect(silent.app.log({ body: { message: "hello" } })).resolves.toBeUndefined()
  })
})

// ─── dual V1 / V2 export shape ────────────────────────────────────────────────

describe("dual V1/V2 plugin export", () => {
  test("default export exposes id, setup, and the V1 server", async () => {
    const mod = await import("./index.js")
    const definition = mod.default

    expect(definition.id).toBe(PLUGIN_ID)
    expect(typeof definition.setup).toBe("function")
    expect(typeof definition.server).toBe("function")
  })

  test("named V1 export is preserved for existing consumers", async () => {
    const mod = await import("./index.js")
    expect(typeof mod.OpenCodeDiscordPresence).toBe("function")
  })
})
