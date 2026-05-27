#!/usr/bin/env bun
import { DEFAULT_CLIENT_ID, DEFAULT_ROTATION_INTERVAL_SECONDS } from "../src/config.ts"
import { DiscordRPCService } from "../src/services/discord-rpc.ts"
import { PresenceOrchestrator } from "../src/services/presence-orchestrator.ts"
import {
  createInitialPresenceState,
  type PresenceSnapshot,
  presenceReducer,
  updateIdentity,
  updateIdle,
} from "../src/state/presence-state.ts"
import type { RichPresenceOptions } from "../src/types/index.ts"

const CLIENT_ID = process.env.OPENCODE_DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID
const HOLD = Number(process.env.HOLD_SECONDS || "5")
const LANGUAGE = (process.env.LANGUAGE === "ko" ? "ko" : "en") as "ko" | "en"

const richOptions: RichPresenceOptions = {
  enableFileSpotlight: false,
  enableMissionBoard: false,
  rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
  diagnostics: { errorsOnly: true },
  mainAgentOnly: false,
}

interface Window {
  name: string
  rpc: DiscordRPCService
  orchestrator: PresenceOrchestrator
  snapshot: PresenceSnapshot
}

function makeWindow(name: string): Window {
  return {
    name,
    rpc: new DiscordRPCService(CLIENT_ID, { debug: true }),
    orchestrator: new PresenceOrchestrator(),
    snapshot: createInitialPresenceState(),
  }
}

async function push(w: Window): Promise<void> {
  await w.rpc.setPresenceFromSnapshot(w.snapshot, richOptions, 0, LANGUAGE)
}

async function busy(w: Window, sessionID: string, agent: string): Promise<void> {
  const { wasIdle } = w.orchestrator.markBusy(sessionID, agent)
  if (wasIdle) w.rpc.resetSessionStart()
  w.snapshot = presenceReducer(w.snapshot, updateIdle(false))
  w.snapshot = presenceReducer(w.snapshot, updateIdentity({ agent }))
  await push(w)
}

async function idle(w: Window, sessionID: string): Promise<void> {
  const { nowAllIdle, lastAgent } = w.orchestrator.markIdle(sessionID)
  if (!nowAllIdle) return
  if (lastAgent) w.snapshot = presenceReducer(w.snapshot, updateIdentity({ agent: lastAgent }))
  w.snapshot = presenceReducer(w.snapshot, updateIdle(true))
  await push(w)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString().slice(11, 19)

async function main(): Promise<void> {
  const A = makeWindow("A")
  const B = makeWindow("B")

  await Promise.all([A.rpc.connect(), B.rpc.connect()])
  await sleep(500)

  console.log(`[mw ${ts()}] WindowA → Working with Prometheus`)
  await busy(A, "ses_a", "Prometheus")
  await sleep(HOLD * 1000)

  console.log(`[mw ${ts()}] WindowB → overwrites with Claude (shared Discord app)`)
  await busy(B, "ses_b", "Claude")
  await sleep(HOLD * 1000)

  console.log(`[mw ${ts()}] WindowA → Prometheus again (last writer wins)`)
  await busy(A, "ses_a", "Prometheus")
  await sleep(HOLD * 1000)

  console.log(`[mw ${ts()}] WindowA idle → its own slot clears`)
  await idle(A, "ses_a")
  await sleep(HOLD * 1000)

  console.log(`[mw ${ts()}] WindowB idle → Claude is idle`)
  await idle(B, "ses_b")
  await sleep(HOLD * 1000)

  console.log(`[mw ${ts()}] shutting down both windows`)
  await Promise.all([A.rpc.disconnect(), B.rpc.disconnect()])
}

main().catch((err: unknown) => {
  console.error("[mw] error:", err)
  process.exit(1)
})
