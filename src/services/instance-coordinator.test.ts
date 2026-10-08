import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InstanceCoordinator, type InstanceRecord } from "./instance-coordinator"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "instance-coord-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writePeer(record: Partial<InstanceRecord> & { pid: number }): void {
  const full: InstanceRecord = {
    pid: record.pid,
    instanceId: record.instanceId ?? `peer-${record.pid}`,
    startedAt: record.startedAt ?? Date.now(),
    lastActivity: record.lastActivity ?? 0,
    lastSeen: record.lastSeen ?? Date.now(),
  }
  writeFileSync(join(dir, `${full.pid}.json`), JSON.stringify(full))
}

describe("InstanceCoordinator", () => {
  describe("construction", () => {
    test("creates own state file with current pid", () => {
      new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      expect(readdirSync(dir)).toContain("1000.json")
    })

    test("isOwner() returns true by default when alone", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      expect(coord.isOwner()).toBe(true)
    })
  })

  describe("leader election", () => {
    test("instance with newer lastActivity wins ownership", () => {
      writePeer({
        pid: 2000,
        startedAt: Date.now() - 5_000,
        lastActivity: Date.now() + 60_000, // far future → guaranteed newer
        lastSeen: Date.now(),
      })

      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      coord.tick()

      expect(coord.isOwner()).toBe(false)
    })

    test("recordActivity + tick reclaims ownership", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 5_000,
        lastActivity: now - 2_000, // peer last active 2 s ago — fresher than mine
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        startedAt: now - 10_000,
        lastActivity: now - 10_000, // I haven't done anything since starting
      })
      coord.tick()
      expect(coord.isOwner()).toBe(false)

      coord.recordActivity() // my lastActivity = Date.now() ≈ now
      coord.tick()
      expect(coord.isOwner()).toBe(true)
    })

    test("F1: new CLI with default lastActivity does NOT beat an older active peer", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 60_000,
        lastActivity: now - 5_000,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(false)
    })

    test("F1: equal lastActivity (sentinel=0) prefers OLDER startedAt", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now,
        lastActivity: 0,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        startedAt: now - 5_000,
        lastActivity: 0,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(true)
    })

    test("F1: equal lastActivity + startedAt prefers LOWER pid (stable+deterministic)", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now,
        lastActivity: 0,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        startedAt: now,
        lastActivity: 0,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(true)
    })
  })

  describe("stale cleanup", () => {
    test("stale peers (lastSeen older than threshold) are excluded and unlinked", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 100_000,
        lastActivity: now - 1_000,
        lastSeen: now - 30_000,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        staleThresholdMs: 10_000,
        staleGracePeriodTicks: 0,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(true)
      expect(readdirSync(dir)).not.toContain("2000.json")
    })

    test("fresh peers are not removed", () => {
      writePeer({
        pid: 2000,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        lastSeen: Date.now(),
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        staleThresholdMs: 10_000,
      })
      coord.tick()

      expect(readdirSync(dir).sort()).toEqual(["1000.json", "2000.json"])
    })
  })

  describe("ownership transitions", () => {
    test("onOwnershipChange fires when transitioning to non-owner", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      const events: boolean[] = []
      coord.onOwnershipChange((isOwner) => events.push(isOwner))

      writePeer({
        pid: 2000,
        startedAt: Date.now(),
        lastActivity: Date.now() + 60_000,
        lastSeen: Date.now(),
      })
      coord.tick()

      expect(events).toEqual([false])
    })

    test("callback does NOT fire when ownership state is unchanged", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      const events: boolean[] = []
      coord.onOwnershipChange((isOwner) => events.push(isOwner))

      coord.tick() // still alone → still owner → no transition
      coord.tick()

      expect(events).toEqual([])
    })

    test("a throwing listener does not break tick", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      coord.onOwnershipChange(() => {
        throw new Error("boom")
      })

      writePeer({
        pid: 2000,
        startedAt: Date.now(),
        lastActivity: Date.now() + 60_000,
        lastSeen: Date.now(),
      })

      expect(() => coord.tick()).not.toThrow()
      expect(coord.isOwner()).toBe(false)
    })
  })

  describe("disposal", () => {
    test("stop() unlinks own state file", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      expect(readdirSync(dir)).toContain("1000.json")
      coord.stop()
      expect(readdirSync(dir)).not.toContain("1000.json")
    })

    test("stop() is idempotent", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      coord.stop()
      expect(() => coord.stop()).not.toThrow()
    })
  })

  describe("malformed peers", () => {
    test("garbage JSON peer files are skipped without throwing", () => {
      writeFileSync(join(dir, "9999.json"), "{not json at all")

      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })

      expect(() => coord.tick()).not.toThrow()
      expect(coord.isOwner()).toBe(true)
    })

    test("non-json files in dir are ignored", () => {
      writeFileSync(join(dir, "stray.txt"), "ignore me")

      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })

      expect(() => coord.tick()).not.toThrow()
      expect(coord.isOwner()).toBe(true)
    })
  })

  describe("F2: atomic writes", () => {
    test("own file is always a complete valid JSON record (no partial overwrite)", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      for (let i = 0; i < 50; i++) {
        coord.recordActivity()
        coord.tick()
        const raw = readFileSync(join(dir, "1000.json"), "utf-8")
        expect(() => JSON.parse(raw)).not.toThrow()
      }
    })

    test("temp files used for atomic write are not treated as peer files", () => {
      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      writeFileSync(join(dir, "1234.json.tmp.xyz"), "{ partial")
      writeFileSync(join(dir, "1234.tmp"), "{ partial")

      expect(() => coord.tick()).not.toThrow()
      expect(coord.isOwner()).toBe(true)
    })
  })

  describe("F4: write-failure forces non-owner (fail-closed)", () => {
    test("constructor with unwritable instancesDir starts as non-owner", () => {
      const blocker = join(dir, "not-a-directory")
      const instancesDir = join(blocker, "instances")
      writeFileSync(blocker, "blocks recursive mkdir")

      const coord = new InstanceCoordinator({ instancesDir, pid: 1000 })
      const events: boolean[] = []
      coord.onOwnershipChange((isOwner) => events.push(isOwner))

      expect(coord.isOwner()).toBe(false)
      expect(events).not.toContain(true)
    })

    test("recovers ownership later when writes start succeeding", () => {
      const blocker = join(dir, "not-a-directory")
      const instancesDir = join(blocker, "instances")
      writeFileSync(blocker, "blocks recursive mkdir")

      const coord = new InstanceCoordinator({ instancesDir, pid: 1000 })
      const events: boolean[] = []
      coord.onOwnershipChange((isOwner) => events.push(isOwner))
      expect(coord.isOwner()).toBe(false)

      rmSync(blocker, { force: true })
      mkdirSync(instancesDir, { recursive: true })
      coord.tick()

      expect(coord.isOwner()).toBe(true)
      expect(events).toEqual([true])
    })

    test("when writeOwnFile fails, instance demotes itself and notifies listeners", () => {
      const readOnlyDir = mkdtempSync(join(tmpdir(), "instance-coord-ro-"))
      try {
        const coord = new InstanceCoordinator({ instancesDir: readOnlyDir, pid: 1000 })
        const events: boolean[] = []
        coord.onOwnershipChange((isOwner) => events.push(isOwner))

        rmSync(readOnlyDir, { recursive: true, force: true })

        coord.tick()

        expect(coord.isOwner()).toBe(false)
        expect(events).toEqual([false])
      } finally {
        rmSync(readOnlyDir, { recursive: true, force: true })
      }
    })
  })

  describe("F5: instanceId guard prevents cross-reload deletion", () => {
    test("stop() does not delete a file rewritten by a different instanceId", () => {
      const coord1 = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        instanceId: "first",
      })
      expect(readdirSync(dir)).toContain("1000.json")

      const coord2 = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        instanceId: "second",
      })
      expect(readdirSync(dir)).toContain("1000.json")

      coord1.stop()

      expect(readdirSync(dir)).toContain("1000.json")
      const raw = readFileSync(join(dir, "1000.json"), "utf-8")
      const record = JSON.parse(raw) as InstanceRecord
      expect(record.instanceId).toBe("second")

      coord2.stop()
      expect(readdirSync(dir)).not.toContain("1000.json")
    })

    test("own record always includes its instanceId", () => {
      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        instanceId: "abc-123",
      })
      coord.tick()
      const record = JSON.parse(readFileSync(join(dir, "1000.json"), "utf-8")) as InstanceRecord
      expect(record.instanceId).toBe("abc-123")
    })

    test("auto-generated instanceId is unique per coordinator", () => {
      const a = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      const b = new InstanceCoordinator({ instancesDir: dir, pid: 1001 })
      const ra = JSON.parse(readFileSync(join(dir, "1000.json"), "utf-8")) as InstanceRecord
      const rb = JSON.parse(readFileSync(join(dir, "1001.json"), "utf-8")) as InstanceRecord
      expect(ra.instanceId).toBeDefined()
      expect(rb.instanceId).toBeDefined()
      expect(ra.instanceId).not.toBe(rb.instanceId)
      a.stop()
      b.stop()
    })
  })

  describe("F7: peer schema validation rejects bogus records", () => {
    test("peer with lastActivity far in the future is ignored", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now,
        lastActivity: now + 24 * 60 * 60 * 1000,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        allowedClockSkewMs: 60_000,
      })
      coord.recordActivity()
      coord.tick()

      expect(coord.isOwner()).toBe(true)
    })

    test("peer with non-finite numeric fields is ignored", () => {
      writeFileSync(
        join(dir, "2000.json"),
        JSON.stringify({
          pid: 2000,
          instanceId: "x",
          startedAt: "not-a-number",
          lastActivity: Number.POSITIVE_INFINITY,
          lastSeen: null,
        }),
      )

      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })

      expect(() => coord.tick()).not.toThrow()
      expect(coord.isOwner()).toBe(true)
    })

    test("peer with negative timestamps is ignored", () => {
      writeFileSync(
        join(dir, "2000.json"),
        JSON.stringify({
          pid: 2000,
          instanceId: "x",
          startedAt: -1,
          lastActivity: -1,
          lastSeen: -1,
        }),
      )

      const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1000 })
      expect(() => coord.tick()).not.toThrow()
      expect(coord.isOwner()).toBe(true)
    })
  })

  describe("F12: recordActivity flush triggers immediate ownership re-evaluation", () => {
    test("recordActivity({ flush: true }) flips ownership in the same call", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 10_000,
        lastActivity: now - 5_000,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
      })
      coord.tick()
      expect(coord.isOwner()).toBe(false)

      coord.recordActivity({ flush: true })

      expect(coord.isOwner()).toBe(true)
    })

    test("recordActivity() without flush leaves ownership state to next tick", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 10_000,
        lastActivity: now - 5_000,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
      })
      coord.tick()
      expect(coord.isOwner()).toBe(false)

      coord.recordActivity()
      expect(coord.isOwner()).toBe(false)

      coord.tick()
      expect(coord.isOwner()).toBe(true)
    })
  })

  describe("F13: stale-cleanup grace period", () => {
    test("stale peer is excluded from election on first scan but not yet unlinked", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 100_000,
        lastActivity: now + 60_000,
        lastSeen: now - 30_000,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        staleThresholdMs: 10_000,
        staleGracePeriodTicks: 2,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(true)
      expect(readdirSync(dir)).toContain("2000.json")
    })

    test("peer is unlinked after grace period elapses across consecutive ticks", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now - 100_000,
        lastActivity: now,
        lastSeen: now - 30_000,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        staleThresholdMs: 10_000,
        staleGracePeriodTicks: 2,
      })

      coord.tick()
      expect(readdirSync(dir)).toContain("2000.json")

      coord.tick()
      expect(readdirSync(dir)).toContain("2000.json")

      coord.tick()
      expect(readdirSync(dir)).not.toContain("2000.json")
    })
  })
})
