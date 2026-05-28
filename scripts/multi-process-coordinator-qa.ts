#!/usr/bin/env bun
/**
 * Real multi-process QA: spawns child processes (each holding its own
 * InstanceCoordinator) and confirms cross-process election works.
 *
 * Each child writes its own pid file and reports ownership status over its
 * stdout. The parent orchestrates the timing and validates the observed
 * sequence against expectations.
 *
 * Run: bun scripts/multi-process-coordinator-qa.ts
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"

type Child = ChildProcessByStdio<Writable, Readable, null>

const WORKER_MODE = process.env.ULW_QA_WORKER === "1"
const __filename = fileURLToPath(import.meta.url)

async function worker(): Promise<void> {
  const { InstanceCoordinator } = await import("../src/services/instance-coordinator.ts")
  const dir = process.env.ULW_QA_DIR
  if (!dir) {
    console.error("worker: ULW_QA_DIR not set")
    process.exit(2)
  }
  const coord = new InstanceCoordinator({
    instancesDir: dir,
    pid: process.pid,
    tickIntervalMs: 100,
    staleThresholdMs: 1000,
    staleGracePeriodTicks: 1,
  })

  coord.onOwnershipChange((isOwner) => {
    process.stdout.write(`OWN:${isOwner ? 1 : 0}\n`)
  })

  process.stdout.write(`OWN:${coord.isOwner() ? 1 : 0}\n`)
  process.stdout.write(`READY:${process.pid}\n`)
  coord.start()

  if (process.stdin) {
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line === "ACT") coord.recordActivity({ flush: true })
        if (line === "TICK") {
          coord.recordActivity({ flush: true })
        }
        if (line === "EXIT") {
          coord.stop()
          process.exit(0)
        }
      }
    })
  }

  setInterval(() => {
    process.stdout.write(`OWN:${coord.isOwner() ? 1 : 0}\n`)
  }, 150).unref()
}

interface Process {
  child: Child
  pid: number
  lastOwn: boolean | null
  log: string[]
}

function spawnWorker(dir: string, label: string): Process {
  const proc: Process = {
    child: spawn(
      "bun",
      ["run", __filename],
      {
        env: { ...process.env, ULW_QA_WORKER: "1", ULW_QA_DIR: dir },
        stdio: ["pipe", "pipe", "inherit"],
      },
    ) as unknown as Child,
    pid: 0,
    lastOwn: null,
    log: [],
  }
  proc.child.stdout.setEncoding("utf8")
  proc.child.stdout.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (!line) continue
      proc.log.push(`${label}:${line}`)
      if (line.startsWith("READY:")) {
        proc.pid = Number(line.slice(6))
      } else if (line.startsWith("OWN:")) {
        proc.lastOwn = line.endsWith("1")
      }
    }
  })
  return proc
}

function send(p: Process, msg: string): void {
  p.child.stdin.write(`${msg}\n`)
}

async function waitReady(p: Process, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (p.pid === 0) {
    if (Date.now() - start > timeoutMs) throw new Error("worker not ready in time")
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function expect(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    console.error(`  ✗ ${msg}`)
    process.exitCode = 1
  }
}

async function parent(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ulw-mp-qa-"))
  console.log(`Spawning workers in ${dir}`)
  try {
    const a = spawnWorker(dir, "A")
    await waitReady(a)
    await sleep(300)
    expect(a.lastOwn === true, "A solo → owner")

    const b = spawnWorker(dir, "B")
    await waitReady(b)
    await sleep(800)
    expect(a.lastOwn === true, "A keeps ownership when B joins idle (no theft)")
    expect(b.lastOwn === false, "B starts as non-owner")

    send(b, "ACT")
    await sleep(800)
    expect(b.lastOwn === true, "B claims ownership after recordActivity flush")
    expect(a.lastOwn === false, "A relinquishes ownership to B")

    send(b, "EXIT")
    await sleep(2_500)
    expect(a.lastOwn === true, "A reclaims ownership after B exits and grace elapses")

    send(a, "EXIT")
    await sleep(200)
    console.log("Done.")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (WORKER_MODE) {
  worker().catch((err) => {
    console.error("worker crashed:", err)
    process.exit(1)
  })
} else {
  parent().catch((err) => {
    console.error("parent crashed:", err)
    process.exit(1)
  })
}
