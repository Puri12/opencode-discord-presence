import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  createRecapCleanupTask,
  DiscordRPCService,
  MAX_RETRIES,
  shouldLogConnectFailure,
} from "./discord-rpc"

// ─── Mock Client ───────────────────────────────────────────────────────────────

type MockUser = {
  setActivity: (activity: unknown) => Promise<void>
  clearActivity: () => Promise<void>
  setActivityCalls: { args: unknown[] }[]
  clearActivityCalls: number
}

type MockClient = {
  on: (event: string, handler: () => void) => void
  login: () => Promise<void>
  destroy: () => Promise<void>
  user: MockUser
  _handlers: Record<string, () => void>
  destroyCalls: number
}

function createMockClient(events: string[] = []): MockClient {
  const user: MockUser = {
    setActivity: async (activity: unknown) => {
      user.setActivityCalls.push({ args: [activity] })
    },
    clearActivity: async () => {
      events.push("clear")
      user.clearActivityCalls++
    },
    setActivityCalls: [],
    clearActivityCalls: 0,
  }

  const handlers: Record<string, () => void> = {}
  const client: MockClient = {
    on: (event: string, handler: () => void) => {
      handlers[event] = handler
    },
    login: async () => {},
    destroy: async () => {
      events.push("destroy")
      client.destroyCalls++
    },
    user,
    _handlers: handlers,
    destroyCalls: 0,
  }

  return client
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DiscordRPCService", () => {
  describe("MAX_RETRIES constant", () => {
    test("MAX_RETRIES is exported and equals 10", () => {
      expect(MAX_RETRIES).toBe(10)
    })
  })

  describe("initial state", () => {
    test("isConnected returns false before connect", () => {
      const rpc = new DiscordRPCService("123")
      expect(rpc.isConnected()).toBe(false)
    })

    test("_getState reflects initial disconnected state", () => {
      const rpc = new DiscordRPCService("123")
      const state = rpc._getState()
      expect(state.connected).toBe(false)
      expect(state.cleared).toBe(false)
      expect(state.disconnecting).toBe(false)
      expect(state.hasCurrentPresence).toBe(false)
      expect(state.hasPendingUpdate).toBe(false)
      expect(state.hasDebounceTimer).toBe(false)
    })
  })

  describe("disconnect()", () => {
    test("disconnect() sets disconnecting flag", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      await rpc.disconnect()
      const state = rpc._getState()
      expect(state.disconnecting).toBe(true)
      expect(state.connected).toBe(false)
    })

    test("disconnect() clears currentPresence", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      await rpc.disconnect()
      const state = rpc._getState()
      expect(state.hasCurrentPresence).toBe(false)
    })

    test("disconnect() clears debounce timer", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      await rpc.disconnect()
      const state = rpc._getState()
      expect(state.hasDebounceTimer).toBe(false)
    })

    test("disconnect() is idempotent — calling multiple times does not throw", async () => {
      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)
      await rpc.disconnect()
      await rpc.disconnect()
      await rpc.disconnect()
      // If we get here without throwing, the test passes
      expect(rpc._getState().disconnecting).toBe(true)
      expect(mockClient.destroyCalls).toBe(1)
    })

    test("disconnect() after connect: isConnected returns false", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      await rpc.disconnect()
      expect(rpc.isConnected()).toBe(false)
    })

    test("disconnect() calls client.destroy exactly once for a live client", async () => {
      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)

      await rpc.disconnect()

      expect(mockClient.destroyCalls).toBe(1)
    })
  })

  describe("recap cleanup task", () => {
    test("cleanup task clears presence before destroy", async () => {
      const events: string[] = []
      const mockClient = createMockClient(events)
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)

      let recapCleared = 0
      const cleanup = createRecapCleanupTask(rpc, () => {
        recapCleared++
        events.push("recap")
      })

      await cleanup()

      expect(recapCleared).toBe(1)
      expect(events).toEqual(["recap", "clear", "destroy"])
    })

    test("cleanup task captures the original rpc instance and cannot clear a newer one", async () => {
      const firstClient = createMockClient()
      const secondClient = createMockClient()
      const sessionA = new DiscordRPCService("123")
      const sessionB = new DiscordRPCService("456")
      // @ts-expect-error — test injection
      sessionA._overrideClient(firstClient)
      // @ts-expect-error — test injection
      sessionB._overrideClient(secondClient)
      sessionA._setConnected(true)
      sessionB._setConnected(true)

      const cleanup = createRecapCleanupTask(sessionA, () => {})
      let activeRpc: DiscordRPCService | null = sessionA
      activeRpc = sessionB

      await cleanup()

      expect(activeRpc).toBe(sessionB)
      expect(firstClient.user.clearActivityCalls).toBe(1)
      expect(firstClient.destroyCalls).toBe(1)
      expect(secondClient.user.clearActivityCalls).toBe(0)
      expect(secondClient.destroyCalls).toBe(0)
    })
  })

  describe("clear()", () => {
    test("clear() calls client.user.clearActivity once when connected", async () => {
      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)

      await rpc.clear()

      expect(mockClient.user.clearActivityCalls).toBe(1)
    })

    test("clear() does not throw when not connected", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(false)
      // clear() should be safe to call when disconnected
      await rpc.clear()
      // Reaching here means no exception was thrown — test passes
    })

    test("clear() sets cleared flag", () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      rpc.clear()
      const state = rpc._getState()
      expect(state.cleared).toBe(true)
    })

    test("clear() cancels pending debounced updates", async () => {
      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)

      // Schedule a setPresence (creates pending update)
      rpc.setPresence("Test Activity", "state")

      // Immediately clear
      await rpc.clear()

      const state = rpc._getState()
      expect(state.hasPendingUpdate).toBe(false)
      expect(state.hasDebounceTimer).toBe(false)
    })

    test("clear() does not call clearActivity when not connected", async () => {
      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(false)

      await rpc.clear()

      expect(mockClient.user.clearActivityCalls).toBe(0)
    })
  })

  describe("setPresence debounce", () => {
    test("multiple rapid setPresence calls schedule only one debounced flush", () => {
      const timers = new Map<number, () => void>()
      let timerId = 0
      const setTimeoutImpl = (fn: () => void, _delay: number) => {
        const id = ++timerId
        timers.set(id, fn)
        return id
      }
      const clearTimeoutImpl = (id: number) => {
        timers.delete(id)
      }

      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)
      rpc._setTimerImpl(
        setTimeoutImpl as unknown as typeof setTimeout,
        clearTimeoutImpl as unknown as typeof clearTimeout,
      )

      rpc.setPresence("Activity 1", "state1")
      rpc.setPresence("Activity 2", "state2")
      rpc.setPresence("Activity 3", "state3")

      // No direct setActivity calls yet — only timer scheduled
      expect(mockClient.user.setActivityCalls.length).toBe(0)
      expect(timers.size).toBe(1) // one debounce timer

      // Advance the timer — triggers flushPendingUpdate
      const flush = timers.get(1)
      expect(flush).not.toBeNull()
      flush?.()

      // Exactly one setActivity call, with the LAST activity
      expect(mockClient.user.setActivityCalls.length).toBe(1)
      const lastCall = mockClient.user.setActivityCalls[0].args[0] as {
        details: string
      }
      expect(lastCall.details).toBe("Activity 3")
    })
  })

  describe("connect failure log gating", () => {
    test("shouldLogConnectFailure emits only on the first attempt (retryCount === 0)", () => {
      expect(shouldLogConnectFailure(0)).toBe(true)
      expect(shouldLogConnectFailure(1)).toBe(false)
      expect(shouldLogConnectFailure(5)).toBe(false)
      expect(shouldLogConnectFailure(MAX_RETRIES)).toBe(false)
    })

    test("warn() is silent when debug is false (default)", async () => {
      const captured: unknown[][] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        captured.push(args)
      }

      try {
        const mockClient = createMockClient()
        mockClient.destroy = async () => {
          throw new Error("boom")
        }

        const rpc = new DiscordRPCService("123")
        // @ts-expect-error — test injection
        rpc._overrideClient(mockClient)
        rpc._setConnected(true)

        await rpc.disconnect()

        expect(captured).toEqual([])
      } finally {
        console.warn = origWarn
      }
    })

    test("warn() emits when debug is true", async () => {
      const captured: unknown[][] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        captured.push(args)
      }

      try {
        const mockClient = createMockClient()
        mockClient.destroy = async () => {
          throw new Error("boom")
        }

        const rpc = new DiscordRPCService("123", { debug: true })
        // @ts-expect-error — test injection
        rpc._overrideClient(mockClient)
        rpc._setConnected(true)

        await rpc.disconnect()

        expect(captured.length).toBe(1)
        expect(String(captured[0][0])).toContain("[discord-presence]")
      } finally {
        console.warn = origWarn
      }
    })
  })

  describe("setPresence buttons", () => {
    test("every activity sent to Discord includes the View on GitHub button", () => {
      const timers = new Map<number, () => void>()
      let timerId = 0
      const setTimeoutImpl = (fn: () => void, _delay: number) => {
        const id = ++timerId
        timers.set(id, fn)
        return id
      }
      const clearTimeoutImpl = (id: number) => {
        timers.delete(id)
      }

      const mockClient = createMockClient()
      const rpc = new DiscordRPCService("123")
      // @ts-expect-error — test injection
      rpc._overrideClient(mockClient)
      rpc._setConnected(true)
      rpc._setTimerImpl(
        setTimeoutImpl as unknown as typeof setTimeout,
        clearTimeoutImpl as unknown as typeof clearTimeout,
      )

      rpc.setPresence("details", "state")
      timers.get(1)?.()

      const activity = mockClient.user.setActivityCalls[0].args[0] as {
        buttons?: Array<{ label: string; url: string }>
      }
      expect(activity.buttons).toEqual([
        {
          label: "View on GitHub",
          url: "https://github.com/Puri12/opencode-discord-presence",
        },
      ])
    })
  })

  describe("reconnect replay guard", () => {
    test("after clear(), currentPresence is null so reconnect cannot replay stale data", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)

      await rpc.setPresence("Stale Activity", "state")
      expect(rpc._getState().hasCurrentPresence).toBe(true)

      await rpc.clear()
      // currentPresence is null after clear
      expect(rpc._getState().hasCurrentPresence).toBe(false)
      expect(rpc._getState().cleared).toBe(true)

      // Even if reconnect fires, the guard `currentPresence && !cleared` is false
      // because currentPresence is null — no replay possible
    })

    test("clear() + reconnect cycle: no stale replay possible", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)

      await rpc.setPresence("Session Activity", "state")
      expect(rpc._getState().hasCurrentPresence).toBe(true)

      await rpc.clear()
      expect(rpc._getState().cleared).toBe(true)
      expect(rpc._getState().hasCurrentPresence).toBe(false)

      // On reconnect, the ready handler checks `currentPresence && !cleared`
      // Since currentPresence is null, replay is skipped — correct
    })
  })

  describe("isConnected", () => {
    test("returns true when connected", () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      expect(rpc.isConnected()).toBe(true)
    })

    test("returns false when disconnected", () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(false)
      expect(rpc.isConnected()).toBe(false)
    })

    test("returns false after disconnect()", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      await rpc.disconnect()
      expect(rpc.isConnected()).toBe(false)
    })
  })

  describe("disconnect() + reconnect prevention", () => {
    test("disconnecting flag prevents scheduleReconnect from setting a timer", async () => {
      const timers: number[] = []
      let timerId = 0
      const setTimeoutImpl = (_fn: () => void, _delay: number) => {
        timerId++
        timers.push(timerId)
        return timerId
      }
      const clearTimeoutImpl = (_id: number) => {}

      const rpc = new DiscordRPCService("123")
      rpc._setTimerImpl(
        setTimeoutImpl as unknown as typeof setTimeout,
        clearTimeoutImpl as unknown as typeof clearTimeout,
      )
      await rpc.disconnect() // sets disconnecting = true

      // scheduleReconnect should return early because disconnecting = true
      // Therefore no timer should be scheduled
      expect(timers.length).toBe(0)
    })
  })

  describe("clientGeneration (stale-callback race fix)", () => {
    test("starts at 0 before any connect", () => {
      const rpc = new DiscordRPCService("123")
      expect(rpc._getClientGeneration()).toBe(0)
    })

    test("connect() increments clientGeneration synchronously", () => {
      const rpc = new DiscordRPCService("123")
      expect(rpc._getClientGeneration()).toBe(0)
      void rpc.connect()
      expect(rpc._getClientGeneration()).toBe(1)
    })

    test("disconnect() increments clientGeneration to invalidate in-flight handlers", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      const before = rpc._getClientGeneration()
      await rpc.disconnect()
      const after = rpc._getClientGeneration()
      expect(after).toBe(before + 1)
    })

    test("connect → disconnect → connect bumps generation each step (no zombie state)", () => {
      const rpc = new DiscordRPCService("123")
      expect(rpc._getClientGeneration()).toBe(0)

      void rpc.connect()
      expect(rpc._getClientGeneration()).toBe(1)
      void rpc.disconnect()
      expect(rpc._getClientGeneration()).toBe(2)

      void rpc.connect()
      expect(rpc._getClientGeneration()).toBe(3)
      void rpc.disconnect()
      expect(rpc._getClientGeneration()).toBe(4)
    })

    test("connect() while already connected returns early without bumping generation", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      const before = rpc._getClientGeneration()
      const result = await rpc.connect()
      expect(result).toBe(true)
      expect(rpc._getClientGeneration()).toBe(before)
    })
  })

  describe("recovery after MAX_RETRIES (self-heal on explicit connect)", () => {
    test("explicit connect() resets retryCount when previously exhausted", () => {
      const rpc = new DiscordRPCService("123")
      rpc._setRetryCount(MAX_RETRIES)
      expect(rpc._getState().retryCount).toBe(MAX_RETRIES)

      void rpc.connect()

      expect(rpc._getState().retryCount).toBe(0)
    })

    test("explicit connect() leaves retryCount untouched when still under budget", () => {
      const rpc = new DiscordRPCService("123")
      rpc._setRetryCount(3)

      void rpc.connect()

      expect(rpc._getState().retryCount).toBe(3)
    })

    test("connect() short-circuit (already connected) does not reset retryCount", async () => {
      const rpc = new DiscordRPCService("123")
      rpc._setConnected(true)
      rpc._setRetryCount(MAX_RETRIES)
      await rpc.connect()
      expect(rpc._getState().retryCount).toBe(MAX_RETRIES)
    })
  })
})

describe("DiscordRPCService logging", () => {
  const originalLog = console.log
  const originalWarn = console.warn
  let logSpy: ReturnType<typeof mock>
  let warnSpy: ReturnType<typeof mock>

  beforeEach(() => {
    logSpy = mock(() => {})
    warnSpy = mock(() => {})
    console.log = logSpy as unknown as typeof console.log
    console.warn = warnSpy as unknown as typeof console.warn
  })

  afterEach(() => {
    console.log = originalLog
    console.warn = originalWarn
  })

  test("default (no options): setPresence/clear/disconnect are silent", async () => {
    const svc = new DiscordRPCService("fake-id")
    await svc.setPresence("x", "y")
    await svc.clear()
    await svc.disconnect()
    expect(logSpy.mock.calls.length).toBe(0)
    expect(warnSpy.mock.calls.length).toBe(0)
  })

  test("debug=false suppresses log() helper", () => {
    const svc = new DiscordRPCService("fake-id", { debug: false })
    type WithPrivates = { log: (m: string) => void; warn: (m: string) => void }
    const inner = svc as unknown as WithPrivates
    inner.log("hello")
    inner.warn("world")
    expect(logSpy.mock.calls.length).toBe(0)
    expect(warnSpy.mock.calls.length).toBe(0)
  })

  test("debug=true routes through console.log/warn with prefix", () => {
    const svc = new DiscordRPCService("fake-id", { debug: true })
    type WithPrivates = { log: (m: string) => void; warn: (m: string) => void }
    const inner = svc as unknown as WithPrivates
    inner.log("hello")
    inner.warn("world")
    expect(logSpy.mock.calls.length).toBe(1)
    expect(logSpy.mock.calls[0][0]).toBe("[discord-presence] hello")
    expect(warnSpy.mock.calls.length).toBe(1)
    expect(warnSpy.mock.calls[0][0]).toBe("[discord-presence] world")
  })
})

describe("DiscordRPCService basics", () => {
  test("isConnected() is false before connect()", () => {
    const svc = new DiscordRPCService("fake-id")
    expect(svc.isConnected()).toBe(false)
  })

  test("setPresence before connect caches but does not error", async () => {
    const svc = new DiscordRPCService("fake-id")
    await svc.setPresence("details", "state")
    expect(svc.isConnected()).toBe(false)
  })

  test("clear before connect is a no-op", async () => {
    const svc = new DiscordRPCService("fake-id")
    await svc.clear()
    expect(svc.isConnected()).toBe(false)
  })

  test("disconnect on unconnected service is safe", async () => {
    const svc = new DiscordRPCService("fake-id")
    await svc.disconnect()
    expect(svc.isConnected()).toBe(false)
  })
})
