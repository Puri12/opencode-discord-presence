#!/usr/bin/env bun
/**
 * Manual QA for InstanceCoordinator on feat/last-active-instance-wins.
 *
 * Exercises the multi-CLI election guarantees the new code is meant to
 * deliver. Pure in-process simulation against a temp dir — no Discord IPC,
 * no opencode process, so it runs anywhere in <2s.
 *
 * Run: bun scripts/multi-cli-coordinator-qa.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InstanceCoordinator,
  type InstanceRecord,
} from "../src/services/instance-coordinator.ts"

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ ${name}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ulw-coord-qa-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function scenario1_noStartupTheft(): Promise<void> {
  section("S1: a freshly-opened CLI does NOT steal presence from an older active CLI")
  withDir((dir) => {
    const older = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1001,
      startedAt: Date.now() - 60_000,
    })
    older.recordActivity()
    older.tick()
    check("older claims ownership", older.isOwner(), true)

    const newer = new InstanceCoordinator({ instancesDir: dir, pid: 1002 })
    newer.tick()
    older.tick()

    check("new CLI does NOT steal", newer.isOwner(), false)
    check("older retains ownership", older.isOwner(), true)
    older.stop()
    newer.stop()
  })
}

async function scenario2_recordActivityFlipsImmediately(): Promise<void> {
  section("S2: recordActivity({flush:true}) flips ownership within one event turn")
  withDir((dir) => {
    const now = Date.now()
    const a = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1001,
      startedAt: now - 10_000,
      lastActivity: now - 5_000,
    })
    a.tick()

    const b = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1002,
      startedAt: now,
    })
    b.tick()
    check("b starts non-owner (a was active 5s ago)", b.isOwner(), false)

    const events: boolean[] = []
    b.onOwnershipChange((isOwner) => events.push(isOwner))

    b.recordActivity({ flush: true })

    check("b is now owner after flush", b.isOwner(), true)
    check("ownership-change listener fired true", events, [true])
    a.stop()
    b.stop()
  })
}

async function scenario3_atomicWriteRace(): Promise<void> {
  section("S3: rapid ticks never expose partial JSON to peer readers")
  withDir((dir) => {
    const a = new InstanceCoordinator({ instancesDir: dir, pid: 1001 })
    let parseFailures = 0
    for (let i = 0; i < 200; i++) {
      a.recordActivity()
      a.tick()
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue
        try {
          JSON.parse(readFileSync(join(dir, name), "utf-8"))
        } catch {
          parseFailures++
        }
      }
    }
    check("no parse failures across 200 tick iterations", parseFailures, 0)
    a.stop()
  })
}

async function scenario4_instanceIdGuard(): Promise<void> {
  section("S4: stop() never deletes a peer's file (instanceId guard)")
  withDir((dir) => {
    const first = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1001,
      instanceId: "first",
    })
    const second = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1001,
      instanceId: "second",
    })

    first.stop()
    const filesAfterFirstStop = readdirSync(dir)
    check("file still present (second wrote on top)", filesAfterFirstStop.includes("1001.json"), true)
    const after = JSON.parse(readFileSync(join(dir, "1001.json"), "utf-8")) as InstanceRecord
    check("file owner is second instance", after.instanceId, "second")

    second.stop()
    check("file removed after correct owner stops", readdirSync(dir).includes("1001.json"), false)
  })
}

async function scenario5_futureTimestampHijackPrevented(): Promise<void> {
  section("S5: peer with future timestamps is ignored (no permanent hijack)")
  withDir((dir) => {
    const future = Date.now() + 24 * 60 * 60 * 1000
    writeFileSync(
      join(dir, "9999.json"),
      JSON.stringify({
        pid: 9999,
        instanceId: "evil",
        startedAt: Date.now(),
        lastActivity: future,
        lastSeen: future,
      }),
    )

    const real = new InstanceCoordinator({ instancesDir: dir, pid: 1001 })
    real.recordActivity()
    real.tick()

    check("real CLI is owner despite future-timestamp peer", real.isOwner(), true)
    real.stop()
  })
}

async function scenario6_writeFailureFailClosed(): Promise<void> {
  section("S6: filesystem write failure → coordinator demotes self (fail-closed)")
  const dir = mkdtempSync(join(tmpdir(), "ulw-coord-qa-fc-"))
  try {
    const coord = new InstanceCoordinator({ instancesDir: dir, pid: 1001 })
    const events: boolean[] = []
    coord.onOwnershipChange((isOwner) => events.push(isOwner))

    rmSync(dir, { recursive: true, force: true })

    coord.tick()
    check("coord demoted itself after write failure", coord.isOwner(), false)
    check("listener notified false", events, [false])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function scenario7_staleGracePreventsWakeStorm(): Promise<void> {
  section("S7: stale-cleanup grace period preserves real peers across wake-storm window")
  withDir((dir) => {
    writeFileSync(
      join(dir, "2002.json"),
      JSON.stringify({
        pid: 2002,
        instanceId: "sleeping",
        startedAt: Date.now() - 60_000,
        lastActivity: Date.now() - 20_000,
        lastSeen: Date.now() - 30_000,
      } satisfies InstanceRecord),
    )

    const coord = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1001,
      staleThresholdMs: 10_000,
      staleGracePeriodTicks: 2,
    })

    coord.tick()
    check("stale peer file not unlinked on first observation", readdirSync(dir).includes("2002.json"), true)

    coord.tick()
    check("stale peer file not unlinked on second observation", readdirSync(dir).includes("2002.json"), true)

    coord.tick()
    check("stale peer file unlinked after grace exceeded", readdirSync(dir).includes("2002.json"), false)
    coord.stop()
  })
}

async function scenario8_threeCliConcurrentStartup(): Promise<void> {
  section("S8: three CLIs starting concurrently elect exactly one owner")
  withDir((dir) => {
    const coords = [1001, 1002, 1003].map(
      (pid, idx) =>
        new InstanceCoordinator({
          instancesDir: dir,
          pid,
          startedAt: Date.now() - (3 - idx) * 100,
        }),
    )
    for (const c of coords) c.tick()
    const owners = coords.filter((c) => c.isOwner()).length
    check("exactly one owner across 3 CLIs", owners, 1)
    for (const c of coords) c.stop()
  })
}

async function scenario9_ownershipFlipOnPeerStop(): Promise<void> {
  section("S9: when current owner stops, next-most-active peer becomes owner")
  withDir((dir) => {
    const a = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1001,
      startedAt: Date.now() - 5_000,
    })
    a.recordActivity()
    a.tick()

    const b = new InstanceCoordinator({
      instancesDir: dir,
      pid: 1002,
      startedAt: Date.now(),
    })
    b.tick()
    check("a is initial owner", a.isOwner(), true)
    check("b is not initial owner", b.isOwner(), false)

    a.stop()
    const evts: boolean[] = []
    b.onOwnershipChange((isOwner) => evts.push(isOwner))
    b.tick()
    b.tick()
    b.tick()

    check("b becomes owner after a stopped + grace", b.isOwner(), true)
    check("listener fired exactly once with true", evts, [true])
    b.stop()
  })
}

async function main(): Promise<void> {
  console.log("Multi-CLI Coordinator manual QA")
  await scenario1_noStartupTheft()
  await scenario2_recordActivityFlipsImmediately()
  await scenario3_atomicWriteRace()
  await scenario4_instanceIdGuard()
  await scenario5_futureTimestampHijackPrevented()
  await scenario6_writeFailureFailClosed()
  await scenario7_staleGracePreventsWakeStorm()
  await scenario8_threeCliConcurrentStartup()
  await scenario9_ownershipFlipOnPeerStop()

  console.log(`\nResult: ${passed} passed, ${failed} failed`)
  await sleep(50)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("QA crashed:", err)
  process.exit(1)
})
