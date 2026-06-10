import { Client } from "@xhayper/discord-rpc"
import type { PresenceSnapshot } from "../state/presence-state.js"
import type { Language, RichPresenceOptions, SetActivity } from "../types/index.js"
import { getActivity } from "../utils/activity-rotation.js"

const RECONNECT_DELAY = 5000
const MAX_RECONNECT_DELAY = 60000
const RECONNECT_JITTER_RATIO = 0.2
const MAX_RETRIES = 10
const DEBOUNCE_MS = 100
export const MIN_UPDATE_GAP_MS = 2000
const MAX_DETAILS_LENGTH = 126
const MAX_STATE_LENGTH = 126

const PRESENCE_BUTTONS: NonNullable<SetActivity["buttons"]> = [
  {
    label: "View on GitHub",
    url: "https://github.com/Puri12/opencode-discord-presence",
  },
]

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 1)}…`
}

export { MAX_RETRIES }

/**
 * Gate for the "Connection failed:" log emitted from the connect() catch path.
 *
 * Returns true ONLY on the initial connect attempt (retryCount === 0). During
 * the scheduleReconnect() retry cycle the catch fires again with retryCount
 * already incremented, so the same identical log would otherwise repeat once
 * per retry (up to MAX_RETRIES + 1 = 11 lines per blocked startup). The
 * subsequent retries stay silent; the final "Max retries reached" log still
 * informs the user the cycle ended. See issue #7 (multi-CLI noise).
 */
export function shouldLogConnectFailure(retryCount: number): boolean {
  return retryCount === 0
}

export interface DiscordRPCOptions {
  debug?: boolean
}

/**
 * DiscordRPCService — hardened Discord Rich Presence client.
 *
 * Logging is silent by default. Pass `{ debug: true }` to surface
 * `[discord-presence]` lifecycle messages via `console.log` / `console.warn`.
 *
 * Test injection points (prefixed with _):
 *   _setConnected(connected)  — override internal connected flag
 *   _overrideClient(client)    — replace the RPC client for unit tests
 *   _setTimerImpl(set, clear) — inject fake timers for debounce/reconnect tests
 *   _getState()                — returns current internal state snapshot
 */
export class DiscordRPCService {
  private client: Client | null = null
  private connectPromise: Promise<boolean> | null = null
  private connected = false
  private retryCount = 0
  private sessionStart: Date = new Date()
  private currentPresence: SetActivity | null = null
  private readonly debug: boolean

  // ── Lifecycle flags ─────────────────────────────────────────────────────
  private cleared = false
  private disconnecting = false

  // Monotonic counter incremented on every connect() and disconnect(). Each
  // client's event handlers capture the generation they were registered for
  // and bail out if it no longer matches — that prevents a stale `ready` (from
  // an old client we already disconnected) from flipping `connected` back to
  // true after `this.client = null`, which would leave the service in a
  // zombie "connected with no client" state where every setActivity is dropped.
  private clientGeneration = 0

  // ── Debounce state ──────────────────────────────────────────────────────
  private pendingUpdate: SetActivity | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private lastFlushAt = 0

  // ── Reconnect timer ─────────────────────────────────────────────────────
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // ── Timer injection (for testing) ───────────────────────────────────────
  private _setTimeoutImpl: typeof setTimeout = setTimeout
  private _clearTimeoutImpl: typeof clearTimeout = clearTimeout
  private _randomImpl: () => number = Math.random

  constructor(
    private clientId: string,
    options: DiscordRPCOptions = {},
  ) {
    this.debug = options.debug ?? false
  }

  // ─── Test injection points ────────────────────────────────────────────

  _setConnected(connected: boolean) {
    this.connected = connected
  }

  _setRetryCount(n: number) {
    this.retryCount = n
  }

  _overrideClient(client: Client) {
    this.client = client
  }

  _setTimerImpl(setTimeoutImpl: typeof setTimeout, clearTimeoutImpl: typeof clearTimeout) {
    this._setTimeoutImpl = setTimeoutImpl
    this._clearTimeoutImpl = clearTimeoutImpl
  }

  _setRandomImpl(randomImpl: () => number) {
    this._randomImpl = randomImpl
  }

  _getState() {
    return {
      connected: this.connected,
      cleared: this.cleared,
      disconnecting: this.disconnecting,
      retryCount: this.retryCount,
      hasPendingUpdate: this.pendingUpdate !== null,
      hasDebounceTimer: this.debounceTimer !== null,
      hasCurrentPresence: this.currentPresence !== null,
      lastFlushAt: this.lastFlushAt,
    }
  }

  _getClientGeneration(): number {
    return this.clientGeneration
  }

  // ─── Connection ───────────────────────────────────────────────────────

  connect(): Promise<boolean> {
    if (this.connected) return Promise.resolve(true)
    if (this.connectPromise) return this.connectPromise

    // connect() is an explicit "I want to be connected" signal. Reset the
    // disconnect-state flags so that (a) scheduleReconnect() can fire after a
    // prior manual disconnect() and (b) the 'ready' replay path is allowed to
    // resend currentPresence. Without this, a coordinator-driven ownership
    // flip (disconnect → reconnect cycle) would silently fail to retry on
    // transient connection failures. See issue #9.
    this.disconnecting = false
    this.cleared = false

    // Self-heal: if a previous retry cycle exhausted MAX_RETRIES and bailed,
    // an external connect() request (ownership flip OR user-activity-driven
    // recovery in the plugin layer) means we should try again with a fresh
    // retry budget. scheduleReconnect() never reaches connect() while at the
    // cap (it bails first), so resetting here only affects explicit callers.
    if (this.retryCount >= MAX_RETRIES) {
      this.retryCount = 0
    }

    const myGeneration = ++this.clientGeneration

    const staleClient = this.client
    this.client = null
    if (staleClient?.destroy) {
      staleClient.destroy().catch((error) => {
        this.warn("Failed to destroy stale RPC client:", error)
      })
    }

    const attempt = new Promise<boolean>((resolve) => {
      try {
        this.client = new Client({ clientId: this.clientId })

        this.client.on("ready", () => {
          if (myGeneration !== this.clientGeneration) return
          this.connected = true
          this.retryCount = 0
          this.log("Connected to Discord")

          if (this.currentPresence && !this.cleared) {
            this.client?.user?.setActivity(this.currentPresence).catch((err) => {
              this.warn("Failed to replay presence:", err)
            })
          }

          resolve(true)
        })

        this.client.on("disconnected", () => {
          if (myGeneration !== this.clientGeneration) return
          this.connected = false
          if (this.disconnecting) return
          this.log("Disconnected")
          this.scheduleReconnect()
        })

        this.client.login().catch((err) => {
          if (myGeneration !== this.clientGeneration) {
            resolve(false)
            return
          }
          if (shouldLogConnectFailure(this.retryCount)) {
            this.log("Connection failed:", err?.message || err)
          }
          this.scheduleReconnect()
          resolve(false)
        })
      } catch (error) {
        this.log("Error:", error)
        this.scheduleReconnect()
        resolve(false)
      }
    })

    const promise = attempt.finally(() => {
      if (this.connectPromise === promise) {
        this.connectPromise = null
      }
    })

    this.connectPromise = promise
    return promise
  }

  /**
   * Explicitly disconnects and prevents any further reconnect attempts.
   * Clears the Discord activity first so the presence disappears immediately,
   * then tears down the WebSocket connection.
   */
  async disconnect(): Promise<void> {
    if (this.disconnecting && !this.client) {
      return
    }

    // Capture before mutating — used to decide whether disconnect() needs to
    // call clearActivity itself or if a prior clear() already handled it.
    const alreadyCleared = this.cleared

    this.disconnecting = true
    this.connected = false
    this.connectPromise = null
    this.retryCount = 0
    this.cleared = true
    this.clientGeneration++

    if (this.debounceTimer) {
      this._clearTimeoutImpl(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.reconnectTimer) {
      this._clearTimeoutImpl(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.pendingUpdate = null
    this.currentPresence = null

    // Clear the Discord activity before destroying the client.
    // Discord does not auto-expire RPC states — without this the last
    // presence would stay visible forever after an unclean shutdown.
    // Skip if a prior clear() already sent clearActivity for this client.
    const client = this.client
    this.client = null

    if (client?.user && !alreadyCleared) {
      try {
        await client.user.clearActivity()
      } catch (error) {
        this.warn("Failed to clear activity:", error)
      }
    }

    if (client?.destroy) {
      try {
        await client.destroy()
      } catch (error) {
        this.warn("Failed to destroy RPC client:", error)
      }
    }
  }

  private scheduleReconnect() {
    if (this.disconnecting) return
    if (this.retryCount >= MAX_RETRIES) {
      this.log("Max retries reached — not scheduling further reconnects")
      return
    }
    this.retryCount++
    if (this.reconnectTimer) {
      this._clearTimeoutImpl(this.reconnectTimer)
    }
    this.reconnectTimer = this._setTimeoutImpl(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.getReconnectDelay())
    this.reconnectTimer.unref?.()
  }

  private getReconnectDelay(): number {
    const exponent = Math.max(0, this.retryCount - 1)
    const baseDelay = Math.min(RECONNECT_DELAY * 2 ** exponent, MAX_RECONNECT_DELAY)
    const jitter = 1 + (this._randomImpl() * 2 - 1) * RECONNECT_JITTER_RATIO
    return Math.round(baseDelay * jitter)
  }

  // ─── Presence updates (debounced) ─────────────────────────────────────

  async setPresence(
    details: string,
    state?: string,
    assets?: {
      largeImageKey?: string
      largeImageText?: string
      smallImageKey?: string
      smallImageText?: string
    },
  ): Promise<void> {
    const activity: SetActivity = {
      details,
      state,
      startTimestamp: this.sessionStart,
      largeImageKey: assets?.largeImageKey ?? "opencode-logo",
      largeImageText: assets?.largeImageText ?? "OpenCode",
      smallImageKey: assets?.smallImageKey,
      smallImageText: assets?.smallImageText,
      buttons: PRESENCE_BUTTONS,
    }

    this.currentPresence = activity
    this.cleared = false

    this.scheduleUpdate(activity)
  }

  private scheduleUpdate(activity: SetActivity) {
    this.pendingUpdate = activity
    if (this.debounceTimer) return

    const now = Date.now()
    const elapsedSinceFlush = now - this.lastFlushAt
    const delay =
      elapsedSinceFlush >= MIN_UPDATE_GAP_MS ? DEBOUNCE_MS : MIN_UPDATE_GAP_MS - elapsedSinceFlush

    this.debounceTimer = this._setTimeoutImpl(() => {
      this.debounceTimer = null
      this.flushPendingUpdate()
    }, delay)
    this.debounceTimer.unref?.()
  }

  private flushPendingUpdate() {
    if (!this.pendingUpdate) return
    if (!this.connected || !this.client?.user) return

    const activity = this.pendingUpdate
    this.pendingUpdate = null
    this.lastFlushAt = Date.now()

    try {
      this.client.user.setActivity(activity).catch((err) => {
        this.warn("Failed to update:", err)
      })
    } catch (error) {
      this.warn("Failed to update:", error)
    }
  }

  async setPresenceFromSnapshot(
    snapshot: PresenceSnapshot,
    opts: RichPresenceOptions,
    rotationIndex: number,
    language: Language = "en",
  ): Promise<void> {
    const activity = getActivity(snapshot, opts, rotationIndex, language)
    await this.setPresence(
      truncate(activity.details, MAX_DETAILS_LENGTH),
      activity.state ? truncate(activity.state, MAX_STATE_LENGTH) : undefined,
      activity.assets,
    )
  }

  // ─── Clear ────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    this.cleared = true
    this.currentPresence = null

    if (this.debounceTimer) {
      this._clearTimeoutImpl(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingUpdate = null

    if (!this.connected || !this.client?.user) return
    try {
      await this.client.user.clearActivity()
    } catch (error) {
      this.warn("Failed to clear activity:", error)
    }
  }

  resetSessionStart(): void {
    this.sessionStart = new Date()
  }

  isConnected(): boolean {
    return this.connected
  }

  private log(message: string, ...args: unknown[]): void {
    if (!this.debug) return
    console.log(`[discord-presence] ${message}`, ...args)
  }

  private warn(message: string, ...args: unknown[]): void {
    if (!this.debug) return
    console.warn(`[discord-presence] ${message}`, ...args)
  }
}
