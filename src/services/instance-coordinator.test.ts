import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
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

function writePeer(record: InstanceRecord): void {
  writeFileSync(join(dir, `${record.pid}.json`), JSON.stringify(record))
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

    test("tiebreak: equal lastActivity prefers higher startedAt", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now, // same startedAt
        lastActivity: now,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        startedAt: now - 1_000, // older
        lastActivity: now,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(false) // peer's startedAt is newer
    })

    test("tiebreak: equal lastActivity + startedAt prefers higher pid", () => {
      const now = Date.now()
      writePeer({
        pid: 2000,
        startedAt: now,
        lastActivity: now,
        lastSeen: now,
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000, // lower pid → loses
        startedAt: now,
        lastActivity: now,
      })
      coord.tick()

      expect(coord.isOwner()).toBe(false)
    })
  })

  describe("stale cleanup", () => {
    test("stale peers (lastSeen older than threshold) are excluded and unlinked", () => {
      writePeer({
        pid: 2000,
        startedAt: Date.now() - 100_000,
        lastActivity: Date.now() + 60_000, // would dominate if alive
        lastSeen: Date.now() - 30_000, // 30 s ago = stale
      })

      const coord = new InstanceCoordinator({
        instancesDir: dir,
        pid: 1000,
        staleThresholdMs: 10_000,
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
})
