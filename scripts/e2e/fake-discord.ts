#!/usr/bin/env bun
/**
 * Fake Discord desktop client for local E2E runs.
 *
 * Listens on `<dir>/discord-ipc-0` and speaks enough of the Discord RPC IPC
 * protocol for @xhayper/discord-rpc: HANDSHAKE -> READY, PING -> PONG, and
 * request frames (SET_ACTIVITY etc.) answered with the same nonce.
 *
 * Modes:
 *   reply  answer every request (normal Discord)
 *   hang   accept the handshake but never answer a request (issue #13)
 *
 * Every received frame is appended to `frames` so tests can assert on what
 * the plugin actually sent.
 */
import { mkdirSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { join } from "node:path"

export type FakeDiscordMode = "reply" | "hang"

export interface FakeDiscordFrame {
  cmd?: string
  args?: Record<string, unknown>
  nonce?: string
}

export interface FakeDiscord {
  socketPath: string
  frames: FakeDiscordFrame[]
  handshakes: number
  setMode(mode: FakeDiscordMode): void
  nextFrame(cmd: string, timeoutMs: number): Promise<FakeDiscordFrame>
  close(): Promise<void>
}

const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_PING = 3
const OP_PONG = 4

function encode(op: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload))
  const header = Buffer.alloc(8)
  header.writeUInt32LE(op, 0)
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

const READY = {
  cmd: "DISPATCH",
  evt: "READY",
  data: {
    v: 1,
    config: { cdn_host: "cdn.discordapp.com", api_endpoint: "//discord.com/api", environment: "production" },
    user: { id: "1", username: "e2e", discriminator: "0", global_name: "e2e", avatar: null, bot: false, flags: 0, premium_type: 0 },
  },
}

export async function startFakeDiscord(dir: string, mode: FakeDiscordMode = "reply"): Promise<FakeDiscord> {
  mkdirSync(dir, { recursive: true })
  const socketPath = join(dir, "discord-ipc-0")
  rmSync(socketPath, { force: true })

  let currentMode = mode
  const frames: FakeDiscordFrame[] = []
  const waiters: { cmd: string; resolve: (f: FakeDiscordFrame) => void }[] = []
  const sockets = new Set<Socket>()
  const state = { handshakes: 0 }

  const onFrame = (socket: Socket, op: number, payload: unknown) => {
    if (op === OP_HANDSHAKE) {
      state.handshakes++
      socket.write(encode(OP_FRAME, READY))
      return
    }
    if (op === OP_PING) {
      socket.write(encode(OP_PONG, payload))
      return
    }
    if (op !== OP_FRAME) return
    const frame = payload as FakeDiscordFrame
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].cmd === frame.cmd) {
        waiters[i].resolve(frame)
        waiters.splice(i, 1)
      }
    }
    if (currentMode === "hang" || !frame.nonce) return
    socket.write(encode(OP_FRAME, { cmd: frame.cmd, evt: null, nonce: frame.nonce, data: frame.args ?? null }))
  }

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const op = buffer.readUInt32LE(0)
        const length = buffer.readUInt32LE(4)
        if (buffer.length < 8 + length) break
        const raw = buffer.subarray(8, 8 + length).toString()
        buffer = buffer.subarray(8 + length)
        let payload: unknown = null
        try {
          payload = raw ? JSON.parse(raw) : null
        } catch {
          continue
        }
        onFrame(socket, op, payload)
      }
    })
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })

  return {
    socketPath,
    frames,
    get handshakes() {
      return state.handshakes
    },
    setMode(next) {
      currentMode = next
    },
    nextFrame(cmd, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${cmd} frame within ${timeoutMs}ms`)), timeoutMs)
        waiters.push({
          cmd,
          resolve: (f) => {
            clearTimeout(timer)
            resolve(f)
          },
        })
      })
    },
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(socketPath, { force: true })
    },
  }
}

if (import.meta.main) {
  const dir = process.argv[2] ?? process.env.XDG_RUNTIME_DIR ?? "/tmp"
  const mode = (process.argv[3] ?? "reply") as FakeDiscordMode
  const fake = await startFakeDiscord(dir, mode)
  console.log(`fake discord (${mode}) listening on ${fake.socketPath}`)
  let seen = 0
  setInterval(() => {
    for (; seen < fake.frames.length; seen++) console.log(JSON.stringify(fake.frames[seen]))
  }, 200)
}
