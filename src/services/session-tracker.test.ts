import { beforeEach, describe, expect, mock, test } from "bun:test"
import { SessionTracker } from "./session-tracker"

interface FakeClient {
  session: {
    get: ReturnType<typeof mock>
  }
}

function makeClient(parentIDBySession: Record<string, string | null | undefined>): FakeClient {
  return {
    session: {
      get: mock(async (params: { path: { id: string } }) => {
        const id = params.path.id
        if (!(id in parentIDBySession)) {
          throw new Error(`session not found: ${id}`)
        }
        return { data: { id, parentID: parentIDBySession[id] } }
      }),
    },
  }
}

describe("SessionTracker", () => {
  let client: FakeClient

  beforeEach(() => {
    client = makeClient({
      ses_main: null,
      ses_sub: "ses_main",
    })
  })

  test("prime with undefined parentID marks session as main", () => {
    const t = new SessionTracker(client as never)
    t.prime("ses_main", undefined)
    expect(t.peek("ses_main")).toBe("main")
  })

  test("prime with parentID marks session as sub", () => {
    const t = new SessionTracker(client as never)
    t.prime("ses_sub", "ses_main")
    expect(t.peek("ses_sub")).toBe("sub")
  })

  test("peek returns unknown for un-primed session without SDK call", () => {
    const t = new SessionTracker(client as never)
    expect(t.peek("ses_main")).toBe("unknown")
    expect(client.session.get.mock.calls.length).toBe(0)
  })

  test("resolve falls back to SDK when not primed", async () => {
    const t = new SessionTracker(client as never)
    const kind = await t.resolve("ses_main")
    expect(kind).toBe("main")
    expect(client.session.get.mock.calls.length).toBe(1)
  })

  test("resolve caches result so subsequent calls do not hit SDK", async () => {
    const t = new SessionTracker(client as never)
    await t.resolve("ses_main")
    await t.resolve("ses_main")
    await t.resolve("ses_main")
    expect(client.session.get.mock.calls.length).toBe(1)
  })

  test("resolve coalesces concurrent calls for the same session", async () => {
    const t = new SessionTracker(client as never)
    const [a, b, c] = await Promise.all([
      t.resolve("ses_sub"),
      t.resolve("ses_sub"),
      t.resolve("ses_sub"),
    ])
    expect(a).toBe("sub")
    expect(b).toBe("sub")
    expect(c).toBe("sub")
    expect(client.session.get.mock.calls.length).toBe(1)
  })

  test("resolve negatively caches missing sessions", async () => {
    const t = new SessionTracker(client as never, { negativeCacheMs: 10_000 })
    expect(await t.resolve("ses_ghost")).toBe("unknown")
    expect(await t.resolve("ses_ghost")).toBe("unknown")
    expect(client.session.get.mock.calls.length).toBe(1)
  })

  test("primed session is preferred over SDK lookup", async () => {
    const t = new SessionTracker(client as never)
    t.prime("ses_main", null)
    const kind = await t.resolve("ses_main")
    expect(kind).toBe("main")
    expect(client.session.get.mock.calls.length).toBe(0)
  })

  test("forget removes a cached session", async () => {
    const t = new SessionTracker(client as never)
    await t.resolve("ses_main")
    expect(t.size()).toBe(1)
    t.forget("ses_main")
    expect(t.size()).toBe(0)
  })

  test("empty sessionID returns unknown without SDK call", async () => {
    const t = new SessionTracker(client as never)
    expect(await t.resolve("")).toBe("unknown")
    expect(client.session.get.mock.calls.length).toBe(0)
  })

  test("SDK returning response without data wrapper still resolves", async () => {
    const flatClient: FakeClient = {
      session: {
        get: mock(async () => ({ id: "ses_x", parentID: null })),
      },
    }
    const t = new SessionTracker(flatClient as never)
    expect(await t.resolve("ses_x")).toBe("main")
  })
})
