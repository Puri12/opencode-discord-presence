#!/usr/bin/env bun
/**
 * End-to-end check against a real `opencode serve` with this plugin loaded and
 * a fake Discord client (scripts/e2e/fake-discord.ts) on the IPC socket.
 *
 *   bun run build
 *   bun scripts/e2e/opencode-e2e.ts [--plugin <path-to-plugin-entry>] [--opencode <bin>]
 *
 * Everything runs in a throwaway HOME / XDG_* tree, so it never touches your
 * real OpenCode config, sessions or Discord.
 *
 * Scenarios:
 *   reply  Discord answers: the plugin loads, connects and sends SET_ACTIVITY.
 *   hang   Discord accepts the handshake but never answers a request
 *          (issue #13). Concurrent prompts must all be persisted, and
 *          opencode must still exit on SIGTERM.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { type FakeDiscord, type FakeDiscordMode, startFakeDiscord } from "./fake-discord.ts"

const { values } = parseArgs({
  options: {
    plugin: { type: "string", default: resolve(import.meta.dir, "../../dist/index.js") },
    opencode: { type: "string", default: "opencode" },
    prompts: { type: "string", default: "12" },
    keep: { type: "boolean", default: false },
  },
})

const PLUGIN = resolve(values.plugin as string)
const OPENCODE = values.opencode as string
const PROMPTS = Number(values.prompts)

interface Env {
  root: string
  env: Record<string, string>
  project: string
  runtime: string
}

function makeEnv(name: string): Env {
  const root = join(tmpdir(), `odp-e2e-${name}-${process.pid}`)
  rmSync(root, { recursive: true, force: true })
  const home = join(root, "home")
  const project = join(root, "project")
  const runtime = join(root, "run")
  for (const dir of [home, project, runtime]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [`file://${PLUGIN}`] }, null, 2),
  )
  writeFileSync(join(project, ".discord-presence.json"), JSON.stringify({ debug: true }))
  return {
    root,
    project,
    runtime,
    env: {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_RUNTIME_DIR: runtime,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  }
}

async function startOpencode(e: Env, port: number) {
  const proc = Bun.spawn([OPENCODE, "serve", "--port", String(port), "--print-logs", "--log-level", "INFO"], {
    cwd: e.project,
    env: e.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const logs: string[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) logs.push(decoder.decode(chunk))
  }
  void pump(proc.stdout)
  void pump(proc.stderr)
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`opencode exited early:\n${logs.join("")}`)
    try {
      if ((await fetch(`${base}/doc`, { signal: AbortSignal.timeout(3000) })).ok) break
    } catch {}
    await Bun.sleep(250)
  }
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}?directory=${encodeURIComponent(e.project)}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    return { status: res.status, data: text ? JSON.parse(text) : null }
  }
  return { proc, logs, api }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, Bun.sleep(ms).then(() => "timeout" as const)])
}

async function runScenario(name: string, mode: FakeDiscordMode, port: number) {
  const e = makeEnv(name)
  const fake: FakeDiscord = await startFakeDiscord(e.runtime, "reply")
  const oc = await startOpencode(e, port)
  const result: Record<string, unknown> = { scenario: name }
  const checks: [string, boolean][] = []
  try {
    const session = await oc.api("POST", "/session", { title: `e2e-${name}` })
    const sessionID = session.data.id as string

    const firstActivity = fake.nextFrame("SET_ACTIVITY", 30_000)
    await oc.api("POST", `/session/${sessionID}/prompt_async`, {
      noReply: true,
      parts: [{ type: "text", text: "warm-up" }],
    })
    const frame = await withTimeout(firstActivity, 30_000)
    checks.push(["plugin connected to Discord", fake.handshakes > 0])
    checks.push(["plugin sent SET_ACTIVITY", frame !== "timeout"])

    fake.setMode(mode)
    const sent = await Promise.all(
      Array.from({ length: PROMPTS }, (_, i) =>
        oc.api("POST", `/session/${sessionID}/prompt_async`, {
          noReply: true,
          parts: [{ type: "text", text: `prompt-${i}` }],
        }),
      ),
    )
    result.accepted = sent.filter((r) => r.status < 300).length

    const expected = PROMPTS + 1
    let persisted = 0
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const messages = await oc.api("GET", `/session/${sessionID}/message`)
      persisted = (messages.data as { info: { role: string } }[]).filter((m) => m.info.role === "user").length
      if (persisted >= expected) break
      await Bun.sleep(250)
    }
    result.persisted = `${persisted}/${expected}`
    checks.push([`all ${expected} prompts persisted`, persisted === expected])

    const stopStart = Date.now()
    oc.proc.kill("SIGTERM")
    const stopped = await withTimeout(oc.proc.exited, 15_000)
    result.sigtermExitMs = Date.now() - stopStart
    checks.push(["opencode exits on SIGTERM", stopped !== "timeout"])
  } finally {
    if (oc.proc.exitCode === null && oc.proc.signalCode === null) oc.proc.kill("SIGKILL")
    await oc.proc.exited
    await fake.close()
    result.setActivityFrames = fake.frames.filter((f) => f.cmd === "SET_ACTIVITY").length
    if (!values.keep) rmSync(e.root, { recursive: true, force: true })
  }
  const pluginLog = oc.logs
    .join("")
    .split("\n")
    .filter((l) => /discord-presence|failed to load plugin/i.test(l))
  return { result, checks, pluginLog }
}

let failed = 0
for (const [name, mode, port] of [
  ["reply", "reply", 47411],
  ["hang", "hang", 47412],
] as const) {
  const { result, checks, pluginLog } = await runScenario(name, mode, port)
  console.log(`\n== ${name}`, JSON.stringify(result))
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`)
    if (!ok) failed++
  }
  if (pluginLog.length) console.log(pluginLog.map((l) => `  | ${l}`).join("\n"))
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed")
process.exit(failed ? 1 : 0)
