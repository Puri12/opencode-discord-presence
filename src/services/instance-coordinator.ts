import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface InstanceRecord {
  pid: number
  startedAt: number
  lastActivity: number
  lastSeen: number
}

export interface CoordinatorOptions {
  instancesDir: string
  pid?: number
  staleThresholdMs?: number
  tickIntervalMs?: number
  /** Override startedAt — test seam for tiebreak assertions. */
  startedAt?: number
  /** Override initial lastActivity — test seam for tiebreak assertions. */
  lastActivity?: number
}

const DEFAULT_STALE_MS = 10_000
const DEFAULT_TICK_MS = 1_000

/**
 * Coordinates multiple OpenCode CLI instances so the most-recently-active
 * one drives Discord Rich Presence. Discord allows only one IPC connection
 * per machine; without coordination the first CLI grabs the socket and
 * later-active CLIs stay silent. See issue #9.
 *
 * Algorithm:
 *   1. Each instance writes `<instancesDir>/<pid>.json` with
 *      { pid, startedAt, lastActivity, lastSeen }.
 *   2. `recordActivity()` updates in-memory `lastActivity`; the next tick
 *      flushes it to disk (debounces high-frequency hooks).
 *   3. `tick()` writes own file, scans the dir, deletes stale peer files
 *      (`lastSeen > staleThresholdMs`), and picks
 *      `max(lastActivity)` as owner with `startedAt`/`pid` tiebreakers.
 *   4. When ownership flips, `onOwnershipChange` listeners fire so the
 *      plugin can connect/disconnect the RPC client.
 *   5. `stop()` unlinks own file on plugin disposal.
 */
export class InstanceCoordinator {
  private readonly pid: number
  private readonly myFile: string
  private readonly staleMs: number
  private readonly tickMs: number
  private readonly startedAt: number

  private timer: ReturnType<typeof setInterval> | null = null
  private isOwnerFlag = true
  private lastActivity: number
  private readonly listeners: Array<(isOwner: boolean) => void> = []

  constructor(opts: CoordinatorOptions) {
    this.pid = opts.pid ?? process.pid
    this.staleMs = opts.staleThresholdMs ?? DEFAULT_STALE_MS
    this.tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS
    this.startedAt = opts.startedAt ?? Date.now()
    this.lastActivity = opts.lastActivity ?? this.startedAt

    mkdirSync(opts.instancesDir, { recursive: true })
    this.myFile = join(opts.instancesDir, `${this.pid}.json`)
    this.writeOwnFile()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick()
    }, this.tickMs)
    this.timer.unref?.()
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      unlinkSync(this.myFile)
    } catch {
      // already gone — fine
    }
  }

  recordActivity(): void {
    this.lastActivity = Date.now()
  }

  isOwner(): boolean {
    return this.isOwnerFlag
  }

  onOwnershipChange(cb: (isOwner: boolean) => void): void {
    this.listeners.push(cb)
  }

  /**
   * Exposed for tests. Production code should call `start()` to schedule
   * ticks; this method runs one tick synchronously.
   */
  tick(): void {
    this.writeOwnFile()
    const winnerPid = this.findWinner()
    const newIsOwner = winnerPid === this.pid

    if (newIsOwner === this.isOwnerFlag) return

    this.isOwnerFlag = newIsOwner
    for (const cb of this.listeners) {
      try {
        cb(newIsOwner)
      } catch {
        // a single listener exception must not break the tick or sibling listeners
      }
    }
  }

  private writeOwnFile(): void {
    const data: InstanceRecord = {
      pid: this.pid,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      lastSeen: Date.now(),
    }
    try {
      writeFileSync(this.myFile, JSON.stringify(data))
    } catch {
      // filesystem trouble — coordinator falls back to optimistic ownership
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: leader election inherently combines per-file parse + staleness GC + multi-key tiebreak; extracting helpers would scatter the algorithm without clarity gain
  private findWinner(): number {
    const dir = dirname(this.myFile)
    const now = Date.now()
    let winnerPid = this.pid
    let winnerActivity = this.lastActivity
    let winnerStartedAt = this.startedAt

    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      return this.pid
    }

    for (const name of files) {
      if (!name.endsWith(".json")) continue
      const filePath = join(dir, name)
      let peer: InstanceRecord
      try {
        peer = JSON.parse(readFileSync(filePath, "utf-8")) as InstanceRecord
      } catch {
        continue
      }

      if (peer.pid === this.pid) continue

      if (now - peer.lastSeen > this.staleMs) {
        try {
          unlinkSync(filePath)
        } catch {
          // race with another instance — fine
        }
        continue
      }

      const better =
        peer.lastActivity > winnerActivity ||
        (peer.lastActivity === winnerActivity && peer.startedAt > winnerStartedAt) ||
        (peer.lastActivity === winnerActivity &&
          peer.startedAt === winnerStartedAt &&
          peer.pid > winnerPid)

      if (better) {
        winnerPid = peer.pid
        winnerActivity = peer.lastActivity
        winnerStartedAt = peer.startedAt
      }
    }

    return winnerPid
  }
}
