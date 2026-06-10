import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfigFile } from "./config-loader.js"

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "odp-config-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("loadConfigFile", () => {
  test("valid project config is returned with no parse error", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".discord-presence.json"), '{"language":"ko"}')
      const result = await loadConfigFile(dir, dir)
      expect(result.options?.language).toBe("ko")
      expect(result.parseError).toBeUndefined()
    })
  })

  test("missing config returns undefined options and no parse error", async () => {
    await withTempDir(async (dir) => {
      const result = await loadConfigFile(dir, dir)
      expect(result.options).toBeUndefined()
      expect(result.parseError).toBeUndefined()
    })
  })

  test("malformed project config reports the failing path in parseError", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".discord-presence.json"), "{not json")
      const result = await loadConfigFile(dir, dir)
      expect(result.parseError).toBeDefined()
      expect(result.parseError?.path).toBe(join(dir, ".discord-presence.json"))
    })
  })
})
