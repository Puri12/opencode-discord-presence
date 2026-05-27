import type { Plugin } from "@opencode-ai/plugin"

type PluginContext = Parameters<Plugin>[0]
type OpenCodeClient = PluginContext["client"]

export type SessionKind = "main" | "sub" | "unknown"

/**
 * In-flight SDK lookups are coalesced so concurrent chat.message events for
 * the same sub-agent only trigger a single `client.session.get` round-trip.
 */
interface PendingLookup {
  promise: Promise<SessionKind>
}

/**
 * Resolves whether a sessionID belongs to the MAIN user-driven session (no
 * parentID) or a SUB-agent (task tool, planner, explore, etc.).
 *
 * Priming via `prime()` from `session.created` / `session.updated` events
 * avoids the SDK round-trip entirely. When priming is unavailable (e.g. first
 * chat.message arrives before the session.created event is observed), the
 * tracker falls back to `client.session.get(sessionID)` with coalescing and
 * a short negative cache so a deleted/missing session is not re-queried in a
 * tight loop.
 */
export class SessionTracker {
  private readonly kinds = new Map<string, SessionKind>()
  private readonly pending = new Map<string, PendingLookup>()
  private readonly negativeUntil = new Map<string, number>()
  private readonly client: OpenCodeClient
  private readonly negativeCacheMs: number

  constructor(client: OpenCodeClient, options: { negativeCacheMs?: number } = {}) {
    this.client = client
    this.negativeCacheMs = options.negativeCacheMs ?? 5000
  }

  /**
   * Seeds the cache from a session.created or session.updated event payload.
   * The OpenCode SDK exposes `info.parentID` on these events, so priming
   * avoids the async lookup on subsequent chat.message events.
   */
  prime(sessionID: string, parentID: string | undefined | null): void {
    if (!sessionID) return
    this.kinds.set(sessionID, parentID ? "sub" : "main")
  }

  /**
   * Returns the cached kind for a session, or "unknown" if we have not yet
   * resolved it. Synchronous — does NOT trigger an SDK lookup.
   */
  peek(sessionID: string): SessionKind {
    return this.kinds.get(sessionID) ?? "unknown"
  }

  /**
   * Resolves the kind via cache → SDK fallback. Concurrent calls for the same
   * sessionID share one in-flight lookup. Missing/deleted sessions are
   * negatively cached for `negativeCacheMs` to prevent hammering the SDK.
   */
  async resolve(sessionID: string): Promise<SessionKind> {
    if (!sessionID) return "unknown"

    const cached = this.kinds.get(sessionID)
    if (cached) return cached

    const negativeExpiry = this.negativeUntil.get(sessionID)
    if (negativeExpiry !== undefined && negativeExpiry > Date.now()) {
      return "unknown"
    }

    const inFlight = this.pending.get(sessionID)
    if (inFlight) return inFlight.promise

    const promise = this.lookup(sessionID)
    this.pending.set(sessionID, { promise })
    try {
      return await promise
    } finally {
      this.pending.delete(sessionID)
    }
  }

  forget(sessionID: string): void {
    this.kinds.delete(sessionID)
    this.negativeUntil.delete(sessionID)
  }

  size(): number {
    return this.kinds.size
  }

  private async lookup(sessionID: string): Promise<SessionKind> {
    try {
      const response = await this.client.session.get({ path: { id: sessionID } })
      const info = (response?.data ?? response) as { parentID?: string | null } | undefined
      if (!info) {
        this.negativeUntil.set(sessionID, Date.now() + this.negativeCacheMs)
        return "unknown"
      }
      const kind: SessionKind = info.parentID ? "sub" : "main"
      this.kinds.set(sessionID, kind)
      this.negativeUntil.delete(sessionID)
      return kind
    } catch {
      this.negativeUntil.set(sessionID, Date.now() + this.negativeCacheMs)
      return "unknown"
    }
  }
}
