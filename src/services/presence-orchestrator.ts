/**
 * Result of a busy/idle transition that the plugin layer needs to apply to
 * the reducer + rotation engine. Returning structured deltas instead of
 * pushing presence directly keeps the orchestrator render-free and testable.
 */
export interface BusyTransition {
  wasIdle: boolean
  lastAgent: string
  lastModel: string
}

export interface IdleTransition {
  nowAllIdle: boolean
  lastAgent: string
  lastModel: string
}

/**
 * Tracks which sessions are currently busy so the plugin can decide when to
 * push idle text vs active presence. Does NOT touch the Discord RPC client —
 * the plugin layer owns rendering via the reducer + setPresenceFromSnapshot.
 *
 * Behaviour:
 *   - `markBusy(sessionID, agent?, model?)` adds the session to the busy set
 *     and records last-writer-wins identity. Returns whether we were idle
 *     before (so the caller can resetSessionStart) and the identity to render.
 *   - `markIdle(sessionID)` removes the session and reports whether the
 *     ENTIRE process is now idle (no other busy sessions). Idle text should
 *     only be pushed when nowAllIdle is true.
 *   - When the same sessionID flips busy → idle → busy, the orchestrator is
 *     idempotent and only the LAST writer's agent is retained.
 */
export class PresenceOrchestrator {
  private readonly busySessions = new Set<string>()
  private lastAgent = ""
  private lastModel = ""

  markBusy(sessionID: string, agent?: string, model?: string): BusyTransition {
    const wasIdle = this.busySessions.size === 0
    if (sessionID) this.busySessions.add(sessionID)
    if (agent) this.lastAgent = agent
    if (model !== undefined) this.lastModel = model
    return {
      wasIdle,
      lastAgent: this.lastAgent,
      lastModel: this.lastModel,
    }
  }

  markIdle(sessionID: string): IdleTransition {
    const had = sessionID ? this.busySessions.delete(sessionID) : false
    const nowAllIdle = had && this.busySessions.size === 0
    return {
      nowAllIdle,
      lastAgent: this.lastAgent,
      lastModel: this.lastModel,
    }
  }

  isBusy(): boolean {
    return this.busySessions.size > 0
  }

  getBusyCount(): number {
    return this.busySessions.size
  }

  getLastAgent(): string {
    return this.lastAgent
  }

  getLastModel(): string {
    return this.lastModel
  }

  reset(): void {
    this.busySessions.clear()
    this.lastAgent = ""
    this.lastModel = ""
  }
}
