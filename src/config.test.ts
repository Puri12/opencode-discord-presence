import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_CLIENT_ID, getConfig } from "./config"

const ENV_KEYS = [
  "OPENCODE_DISCORD_ENABLED",
  "OPENCODE_DISCORD_CLIENT_ID",
  "OPENCODE_DISCORD_LANGUAGE",
  "OPENCODE_DISCORD_DEBUG",
] as const

describe("getConfig", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test("returns correct defaults when no options or env vars provided", () => {
    const config = getConfig()
    expect(config.enabled).toBe(true)
    expect(config.clientId).toBe(DEFAULT_CLIENT_ID)
    expect(config.language).toBe("en")
    expect(config.debug).toBe(false)
    expect(config.richPresence).toBeDefined()
  })

  test("returns correct defaults when options are partially undefined", () => {
    const config = getConfig({})
    expect(config.enabled).toBe(true)
    expect(config.clientId).toBe(DEFAULT_CLIENT_ID)
    expect(config.language).toBe("en")
    expect(config.debug).toBe(false)
  })

  test("parses legacy enabled option from options object", () => {
    const config = getConfig({ enabled: false })
    expect(config.enabled).toBe(false)
  })

  test("parses legacy applicationId option from options object", () => {
    const config = getConfig({ applicationId: "1234567890" })
    expect(config.clientId).toBe("1234567890")
  })

  test("parses nested discordPresence.applicationId option from options object", () => {
    const config = getConfig({
      discordPresence: { applicationId: "0987654321" },
    } as Parameters<typeof getConfig>[0])
    expect(config.clientId).toBe("0987654321")
  })

  test("prefers top-level applicationId over nested discordPresence.applicationId", () => {
    const config = getConfig({
      applicationId: "top-level-id",
      discordPresence: { applicationId: "nested-id" },
    } as Parameters<typeof getConfig>[0])
    expect(config.clientId).toBe("top-level-id")
  })

  test("parses legacy language option from options object (en)", () => {
    const config = getConfig({ language: "en" })
    expect(config.language).toBe("en")
  })

  test("parses legacy language option from options object (ko)", () => {
    const config = getConfig({ language: "ko" })
    expect(config.language).toBe("ko")
  })

  test("parses legacy language option case-insensitively", () => {
    expect(getConfig({ language: "EN" }).language).toBe("en")
    expect(getConfig({ language: "KO" }).language).toBe("ko")
    expect(getConfig({ language: "KR" }).language).toBe("ko")
    expect(getConfig({ language: "korean" }).language).toBe("ko")
  })

  test("env vars used when file options absent", () => {
    process.env.OPENCODE_DISCORD_ENABLED = "false"
    process.env.OPENCODE_DISCORD_CLIENT_ID = "111"
    process.env.OPENCODE_DISCORD_LANGUAGE = "ko"
    process.env.OPENCODE_DISCORD_DEBUG = "true"
    const config = getConfig()
    expect(config.enabled).toBe(false)
    expect(config.clientId).toBe("111")
    expect(config.language).toBe("ko")
    expect(config.debug).toBe(true)
  })

  test("file option wins over env", () => {
    process.env.OPENCODE_DISCORD_CLIENT_ID = "envID"
    process.env.OPENCODE_DISCORD_LANGUAGE = "en"
    process.env.OPENCODE_DISCORD_DEBUG = "true"
    const config = getConfig({ applicationId: "fileID", language: "ko", debug: false })
    expect(config.clientId).toBe("fileID")
    expect(config.language).toBe("ko")
    expect(config.debug).toBe(false)
  })

  test("language fallback to 'en' for unknown values", () => {
    expect(getConfig({ language: "fr" }).language).toBe("en")
    expect(getConfig({ language: "" }).language).toBe("en")
  })

  test("enabled env: only literal 'false' disables", () => {
    process.env.OPENCODE_DISCORD_ENABLED = "yes"
    expect(getConfig().enabled).toBe(true)
    process.env.OPENCODE_DISCORD_ENABLED = "false"
    expect(getConfig().enabled).toBe(false)
  })

  test("debug parses env var: true/1/yes → true; false/0/no → false; default false", () => {
    expect(getConfig().debug).toBe(false)
    for (const v of ["true", "TRUE", "1", "yes"]) {
      process.env.OPENCODE_DISCORD_DEBUG = v
      expect(getConfig().debug).toBe(true)
    }
    for (const v of ["false", "0", "no"]) {
      process.env.OPENCODE_DISCORD_DEBUG = v
      expect(getConfig().debug).toBe(false)
    }
    process.env.OPENCODE_DISCORD_DEBUG = "garbage"
    expect(getConfig().debug).toBe(false)
  })

  test("debug: option always wins over env", () => {
    process.env.OPENCODE_DISCORD_DEBUG = "false"
    expect(getConfig({ debug: true }).debug).toBe(true)
    process.env.OPENCODE_DISCORD_DEBUG = "true"
    expect(getConfig({ debug: false }).debug).toBe(false)
  })

  test("parses rich presence enableFileSpotlight option (default false for privacy)", () => {
    const config = getConfig({})
    expect(config.richPresence.enableFileSpotlight).toBe(false)
  })

  test("parses rich presence enableMissionBoard option (default true)", () => {
    const config = getConfig({})
    expect(config.richPresence.enableMissionBoard).toBe(true)
  })

  test("accepts rich presence enableFileSpotlight as false", () => {
    const config = getConfig({ richPresence: { enableFileSpotlight: false } })
    expect(config.richPresence.enableFileSpotlight).toBe(false)
  })

  test("accepts rich presence enableMissionBoard as false", () => {
    const config = getConfig({ richPresence: { enableMissionBoard: false } })
    expect(config.richPresence.enableMissionBoard).toBe(false)
  })

  test("rotation interval defaults to 20", () => {
    const config = getConfig({})
    expect(config.richPresence.rotationIntervalSeconds).toBe(20)
  })

  test("rotation interval accepts value at lower boundary (10)", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: 10 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(10)
  })

  test("rotation interval accepts value at upper boundary (60)", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: 60 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(60)
  })

  test("rotation interval clamps negative values to minimum (10)", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: -5 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(10)
  })

  test("rotation interval clamps zero to minimum (10)", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: 0 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(10)
  })

  test("rotation interval clamps values below minimum to 10", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: 5 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(10)
  })

  test("rotation interval clamps values above maximum to 60", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: 100 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(60)
  })

  test("rotation interval accepts floating point and rounds to integer", () => {
    const config = getConfig({ richPresence: { rotationIntervalSeconds: 25.7 } })
    expect(config.richPresence.rotationIntervalSeconds).toBe(26)
  })

  test("ignores non-numeric rotation interval and falls back to default", () => {
    const config = getConfig({
      richPresence: { rotationIntervalSeconds: "twenty" },
    } as unknown as Parameters<typeof getConfig>[0])
    expect(config.richPresence.rotationIntervalSeconds).toBe(20)
  })

  test("richPresence diagnostics field exists with errorsOnly default true", () => {
    const config = getConfig({})
    expect(config.richPresence.diagnostics.errorsOnly).toBe(true)
  })

  test("richPresence diagnostics errorsOnly can be set to false", () => {
    const config = getConfig({
      richPresence: { diagnostics: { errorsOnly: false } },
    })
    expect(config.richPresence.diagnostics.errorsOnly).toBe(false)
  })

  test("legacy options still work alongside new richPresence options", () => {
    const config = getConfig({
      enabled: false,
      applicationId: "custom-id",
      language: "ko",
      debug: true,
      richPresence: {
        enableFileSpotlight: false,
        enableMissionBoard: false,
        rotationIntervalSeconds: 30,
      },
    })
    expect(config.enabled).toBe(false)
    expect(config.clientId).toBe("custom-id")
    expect(config.language).toBe("ko")
    expect(config.debug).toBe(true)
    expect(config.richPresence.enableFileSpotlight).toBe(false)
    expect(config.richPresence.enableMissionBoard).toBe(false)
    expect(config.richPresence.rotationIntervalSeconds).toBe(30)
  })

  test("undefined richPresence key defaults all rich options", () => {
    const config = getConfig({ richPresence: undefined })
    expect(config.richPresence.enableFileSpotlight).toBe(false)
    expect(config.richPresence.enableMissionBoard).toBe(true)
    expect(config.richPresence.rotationIntervalSeconds).toBe(20)
  })

  test("partial richPresence keys get safe defaults for omitted keys", () => {
    const config = getConfig({ richPresence: { enableMissionBoard: false } })
    expect(config.richPresence.enableMissionBoard).toBe(false)
    expect(config.richPresence.enableFileSpotlight).toBe(false)
    expect(config.richPresence.rotationIntervalSeconds).toBe(20)
  })

  test("explicit enableFileSpotlight: true opts in to file name display", () => {
    const config = getConfig({ richPresence: { enableFileSpotlight: true } })
    expect(config.richPresence.enableFileSpotlight).toBe(true)
  })
})
