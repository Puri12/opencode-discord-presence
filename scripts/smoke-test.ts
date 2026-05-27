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
const HOLD = Number(process.env.HOLD_SECONDS || "6")
const LANGUAGE = (process.env.LANGUAGE === "en" ? "en" : "ko") as "ko" | "en"

const richOptions: RichPresenceOptions = {
  enableFileSpotlight: false,
  enableMissionBoard: false,
  rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
  diagnostics: { errorsOnly: true },
  mainAgentOnly: false,
}

const rpc = new DiscordRPCService(CLIENT_ID, { debug: true })
const orchestrator = new PresenceOrchestrator()
let snapshot: PresenceSnapshot = createInitialPresenceState()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ts = () => new Date().toISOString().slice(11, 19)

async function push(): Promise<void> {
  await rpc.setPresenceFromSnapshot(snapshot, richOptions, 0, LANGUAGE)
}

async function busy(sessionID: string, agent: string, model = ""): Promise<void> {
  const { wasIdle } = orchestrator.markBusy(sessionID, agent, model)
  if (wasIdle) rpc.resetSessionStart()
  snapshot = presenceReducer(snapshot, updateIdle(false))
  snapshot = presenceReducer(snapshot, updateIdentity({ agent, model }))
  await push()
}

async function idle(sessionID: string): Promise<void> {
  const { nowAllIdle, lastAgent } = orchestrator.markIdle(sessionID)
  if (!nowAllIdle) return
  if (lastAgent) snapshot = presenceReducer(snapshot, updateIdentity({ agent: lastAgent }))
  snapshot = presenceReducer(snapshot, updateIdle(true))
  await push()
}

async function main(): Promise<void> {
  console.log(`[smoke ${ts()}] clientId=${CLIENT_ID} language=${LANGUAGE} HOLD=${HOLD}s`)
  await rpc.connect()
  await sleep(500)

  console.log(`[smoke ${ts()}] step 1: MAIN busy → Sisyphus`)
  await busy("ses_main", "Sisyphus", "claude-sonnet-4")
  await sleep(HOLD * 1000)

  console.log(`[smoke ${ts()}] step 2: SUB busy → overwrite to planner (last-writer-wins)`)
  await busy("ses_sub", "planner", "claude-haiku-4")
  await sleep(HOLD * 1000)

  console.log(`[smoke ${ts()}] step 3: SUB idle → main still busy, presence STAYS planner`)
  await idle("ses_sub")
  await sleep(HOLD * 1000)

  console.log(`[smoke ${ts()}] step 4: MAIN sends again → Sisyphus`)
  await busy("ses_main", "Sisyphus", "claude-sonnet-4")
  await sleep(HOLD * 1000)

  console.log(`[smoke ${ts()}] step 5: MAIN idle → Sisyphus is idle / 휴식중`)
  await idle("ses_main")
  await sleep(HOLD * 1000)

  console.log(`[smoke ${ts()}] DONE — disconnecting`)
  await rpc.disconnect()
}

main().catch((err: unknown) => {
  console.error("[smoke] error:", err)
  process.exit(1)
})
