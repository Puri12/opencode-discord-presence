import { Client } from "@xhayper/discord-rpc"
import type { PresenceSnapshot } from "../state/presence-state.js"
import type { Language, RichPresenceOptions, SetActivity } from "../types/index.js"
import { getActivity } from "../utils/activity-rotation.js"

const RECONNECT_DELAY = 5000
const MAX_RETRIES = 10
const DEBOUNCE_MS = 100
const MAX_DETAILS_LENGTH = 126
const MAX_STATE_LENGTH = 126

const PRESENCE_BUTTONS: NonNullable<SetActivity["buttons"]> = [
  {
    label: "View on GitHub",
    url: "https://github.com/Puri12/opencode-discord-presence",
  },
]

export function createRecapCleanupTask(
  rpc: DiscordRPCService | null,
  clearRecapState: () => void,
): () => Promise<void> {
  return async () => {
    clearRecapState()
    if (!rpc) return
    await rpc.clear()
    await rpc.disconnect()
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 1)}…`
}

export { MAX_RETRIES }

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
  private connected = false
  private retryCount = 0
  private sessionStart: Date = new Date()
  private currentPresence: SetActivity | null = null
  private readonly debug: boolean

  // ── Lifecycle flags ─────────────────────────────────────────────────────
  private cleared = false
  private disconnecting = false

  // ── Debounce state ──────────────────────────────────────────────────────
  private pendingUpdate: SetActivity | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  // ── Reconnect timer ─────────────────────────────────────────────────────
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // ── Timer injection (for testing) ───────────────────────────────────────
  private _setTimeoutImpl: typeof setTimeout = setTimeout
  private _clearTimeoutImpl: typeof clearTimeout = clearTimeout

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

  _overrideClient(client: Client) {
    this.client = client
  }

  _setTimerImpl(setTimeoutImpl: typeof setTimeout, clearTimeoutImpl: typeof clearTimeout) {
    this._setTimeoutImpl = setTimeoutImpl
    this._clearTimeoutImpl = clearTimeoutImpl
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
    }
  }

  // ─── Connection ───────────────────────────────────────────────────────

  async connect(): Promise<boolean> {
    if (this.connected) return true

    // connect() is an explicit "I want to be connected" signal. Reset the
    // disconnect-state flags so that (a) scheduleReconnect() can fire after a
    // prior manual disconnect() and (b) the 'ready' replay path is allowed to
    // resend currentPresence. Without this, a coordinator-driven ownership
    // flip (disconnect → reconnect cycle) would silently fail to retry on
    // transient connection failures. See issue #9.
    this.disconnecting = false
    this.cleared = false

    return new Promise((resolve) => {
      try {
        this.client = new Client({ clientId: this.clientId })

        this.client.on("ready", () => {
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
          this.connected = false
          if (this.disconnecting) return
          this.log("Disconnected")
          this.scheduleReconnect()
        })

        this.client.login().catch((err) => {
          this.log("Connection failed:", err?.message || err)
          this.scheduleReconnect()
          resolve(false)
        })
      } catch (error) {
        this.log("Error:", error)
        this.scheduleReconnect()
        resolve(false)
      }
    })
  }

  /**
   * Explicitly disconnects and prevents any further reconnect attempts.
   * Clears all connection state and pending updates.
   */
  async disconnect(): Promise<void> {
    if (this.disconnecting && !this.client) {
      return
    }

    this.disconnecting = true
    this.connected = false
    this.retryCount = 0
    this.cleared = true

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

    const client = this.client
    this.client = null

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
    }, RECONNECT_DELAY)
    this.reconnectTimer.unref?.()
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

    this.debounceTimer = this._setTimeoutImpl(() => {
      this.debounceTimer = null
      this.flushPendingUpdate()
    }, DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  private flushPendingUpdate() {
    if (!this.pendingUpdate) return
    if (!this.connected || !this.client?.user) return

    const activity = this.pendingUpdate
    this.pendingUpdate = null

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
