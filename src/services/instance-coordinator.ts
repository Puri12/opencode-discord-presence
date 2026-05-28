import { randomUUID } from "node:crypto"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

export interface InstanceRecord {
  pid: number
  instanceId: string
  startedAt: number
  lastActivity: number
  lastSeen: number
}

export interface CoordinatorOptions {
  instancesDir: string
  pid?: number
  instanceId?: string
  staleThresholdMs?: number
  tickIntervalMs?: number
  startedAt?: number
  lastActivity?: number
  allowedClockSkewMs?: number
  staleGracePeriodTicks?: number
}

const DEFAULT_STALE_MS = 10_000
const DEFAULT_TICK_MS = 1_000
const DEFAULT_CLOCK_SKEW_MS = 60_000
const DEFAULT_STALE_GRACE_TICKS = 2
const NEVER_ACTIVE = 0

/**
 * Coordinates multiple OpenCode CLI instances so the most-recently-active
 * one drives Discord Rich Presence. Discord allows only one IPC connection
 * per machine; without coordination the first CLI grabs the socket and
 * later-active CLIs stay silent. See issue #9.
 *
 * Files: <instancesDir>/<pid>.json containing { pid, instanceId, startedAt,
 * lastActivity, lastSeen }. Writes are atomic (temp + rename). A new CLI
 * starts with lastActivity=0 so it never steals presence from an older
 * instance whose user actually typed something.
 */
export class InstanceCoordinator {
  private readonly pid: number
  private readonly instanceId: string
  private readonly myFile: string
  private readonly staleMs: number
  private readonly tickMs: number
  private readonly startedAt: number
  private readonly allowedSkewMs: number
  private readonly staleGraceTicks: number
  private readonly staleObservations = new Map<number, number>()

  private timer: ReturnType<typeof setInterval> | null = null
  private isOwnerFlag = true
  private lastActivity: number
  private readonly listeners: Array<(isOwner: boolean) => void> = []

  constructor(opts: CoordinatorOptions) {
    this.pid = opts.pid ?? process.pid
    this.instanceId = opts.instanceId ?? randomUUID()
    this.staleMs = opts.staleThresholdMs ?? DEFAULT_STALE_MS
    this.tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS
    this.startedAt = opts.startedAt ?? Date.now()
    this.lastActivity = opts.lastActivity ?? NEVER_ACTIVE
    this.allowedSkewMs = opts.allowedClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS
    this.staleGraceTicks = opts.staleGracePeriodTicks ?? DEFAULT_STALE_GRACE_TICKS

    try {
      mkdirSync(opts.instancesDir, { recursive: true })
    } catch {
      // proceed; writeOwnFile will fail and demote us via fail-closed path
    }
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
      const raw = readFileSync(this.myFile, "utf-8")
      const record = JSON.parse(raw) as Partial<InstanceRecord>
      if (record.instanceId !== this.instanceId) return
    } catch {
      return
    }
    try {
      unlinkSync(this.myFile)
    } catch {
      // already gone — fine
    }
  }

  recordActivity(opts?: { flush?: boolean }): void {
    this.lastActivity = Date.now()
    if (opts?.flush) {
      this.tick()
    }
  }

  isOwner(): boolean {
    return this.isOwnerFlag
  }

  onOwnershipChange(cb: (isOwner: boolean) => void): void {
    this.listeners.push(cb)
  }

  /** Exposed for tests; production code calls start() to schedule periodic ticks. */
  tick(): void {
    const wrote = this.writeOwnFile()
    if (!wrote) {
      this.applyOwnership(false)
      return
    }
    const winnerPid = this.findWinner()
    this.applyOwnership(winnerPid === this.pid)
  }

  private applyOwnership(newIsOwner: boolean): void {
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

  private writeOwnFile(): boolean {
    const data: InstanceRecord = {
      pid: this.pid,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      lastSeen: Date.now(),
    }
    const json = JSON.stringify(data)
    const tmp = `${this.myFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      writeFileSync(tmp, json)
    } catch {
      return false
    }
    try {
      renameSync(tmp, this.myFile)
      return true
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        // best effort cleanup of orphaned temp
      }
      return false
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: leader election inherently combines per-file parse + schema validation + grace-period staleness GC + multi-key tiebreak; extracting helpers would scatter the algorithm without clarity gain
  private findWinner(): number {
    const dir = dirname(this.myFile)
    const now = Date.now()
    const skewCeiling = now + this.allowedSkewMs
    let winnerPid = this.pid
    let winnerActivity = this.lastActivity
    let winnerStartedAt = this.startedAt

    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      return this.pid
    }

    const seenPeers = new Set<number>()

    for (const name of files) {
      if (!name.endsWith(".json")) continue
      const filePath = join(dir, name)
      let peer: InstanceRecord
      try {
        peer = JSON.parse(readFileSync(filePath, "utf-8")) as InstanceRecord
      } catch {
        continue
      }

      if (!isValidRecord(peer, skewCeiling)) continue
      if (peer.pid === this.pid) continue

      seenPeers.add(peer.pid)

      if (now - peer.lastSeen > this.staleMs) {
        const observed = (this.staleObservations.get(peer.pid) ?? 0) + 1
        this.staleObservations.set(peer.pid, observed)
        if (observed > this.staleGraceTicks) {
          try {
            unlinkSync(filePath)
          } catch {
            // race with another instance — fine
          }
          this.staleObservations.delete(peer.pid)
        }
        continue
      }

      this.staleObservations.delete(peer.pid)

      if (peerWins(peer, winnerActivity, winnerStartedAt, winnerPid)) {
        winnerPid = peer.pid
        winnerActivity = peer.lastActivity
        winnerStartedAt = peer.startedAt
      }
    }

    for (const observedPid of this.staleObservations.keys()) {
      if (!seenPeers.has(observedPid)) this.staleObservations.delete(observedPid)
    }

    return winnerPid
  }
}

function isValidRecord(peer: Partial<InstanceRecord>, skewCeiling: number): peer is InstanceRecord {
  if (
    typeof peer.pid !== "number" ||
    typeof peer.instanceId !== "string" ||
    typeof peer.startedAt !== "number" ||
    typeof peer.lastActivity !== "number" ||
    typeof peer.lastSeen !== "number"
  ) {
    return false
  }
  if (
    !Number.isFinite(peer.pid) ||
    !Number.isFinite(peer.startedAt) ||
    !Number.isFinite(peer.lastActivity) ||
    !Number.isFinite(peer.lastSeen)
  ) {
    return false
  }
  if (peer.startedAt < 0 || peer.lastActivity < 0 || peer.lastSeen < 0) return false
  if (peer.lastActivity > skewCeiling || peer.lastSeen > skewCeiling) return false
  return true
}

function peerWins(
  peer: InstanceRecord,
  winnerActivity: number,
  winnerStartedAt: number,
  winnerPid: number,
): boolean {
  if (peer.lastActivity > winnerActivity) return true
  if (peer.lastActivity < winnerActivity) return false
  if (peer.startedAt < winnerStartedAt) return true
  if (peer.startedAt > winnerStartedAt) return false
  return peer.pid < winnerPid
}
