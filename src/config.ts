import type {
  DiscordPresenceOptions,
  Language,
  PresenceConfig,
  RichPresenceOptions,
} from "./types/index.js"

type CompatibleDiscordPresenceOptions = DiscordPresenceOptions & {
  discordPresence?: {
    applicationId?: string
  }
}

export const DEFAULT_CLIENT_ID = "1466770544748662819"

/** Default rotation interval in seconds. Must be within 10-60 range. */
export const DEFAULT_ROTATION_INTERVAL_SECONDS = 20

/** Minimum allowed rotation interval in seconds. */
export const MIN_ROTATION_INTERVAL_SECONDS = 10

/** Maximum allowed rotation interval in seconds. */
export const MAX_ROTATION_INTERVAL_SECONDS = 60

function parseLanguage(lang?: string): Language {
  const normalized = lang?.toLowerCase()
  if (normalized === "ko" || normalized === "kr" || normalized === "korean") return "ko"
  return "en"
}

/**
 * Clamps and parses rotation interval safely.
 * Invalid values fall back to DEFAULT_ROTATION_INTERVAL_SECONDS.
 */
function parseRotationInterval(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_ROTATION_INTERVAL_SECONDS
  }
  const rounded = Math.round(raw)
  if (rounded < MIN_ROTATION_INTERVAL_SECONDS) {
    return MIN_ROTATION_INTERVAL_SECONDS
  }
  if (rounded > MAX_ROTATION_INTERVAL_SECONDS) {
    return MAX_ROTATION_INTERVAL_SECONDS
  }
  return rounded
}

/**
 * Parses rich presence options with safe defaults.
 * Omitted keys receive safe defaults so partial configs are always safe.
 */
function parseRichPresenceOptions(raw?: Partial<RichPresenceOptions>): RichPresenceOptions {
  if (raw == null) {
    return {
      enableFileSpotlight: false,
      enableMissionBoard: true,
      rotationIntervalSeconds: DEFAULT_ROTATION_INTERVAL_SECONDS,
      diagnostics: { errorsOnly: true },
      mainAgentOnly: false,
    }
  }
  return {
    enableFileSpotlight: raw.enableFileSpotlight ?? false,
    enableMissionBoard: raw.enableMissionBoard ?? true,
    rotationIntervalSeconds: parseRotationInterval(raw.rotationIntervalSeconds),
    diagnostics: {
      errorsOnly: raw.diagnostics?.errorsOnly ?? true,
    },
    mainAgentOnly: raw.mainAgentOnly ?? false,
  }
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.toLowerCase()
  if (v === "true" || v === "1" || v === "yes") return true
  if (v === "false" || v === "0" || v === "no") return false
  return undefined
}

export function getConfig(options?: DiscordPresenceOptions): PresenceConfig {
  const compatibleOptions = options as CompatibleDiscordPresenceOptions | undefined
  const envEnabled = process.env.OPENCODE_DISCORD_ENABLED
  const envClientId = process.env.OPENCODE_DISCORD_CLIENT_ID
  const envLanguage = process.env.OPENCODE_DISCORD_LANGUAGE
  const envDebug = process.env.OPENCODE_DISCORD_DEBUG

  return {
    enabled: options?.enabled ?? envEnabled !== "false",
    clientId:
      compatibleOptions?.applicationId ??
      compatibleOptions?.discordPresence?.applicationId ??
      envClientId ??
      DEFAULT_CLIENT_ID,
    language: parseLanguage(options?.language ?? envLanguage),
    richPresence: parseRichPresenceOptions(options?.richPresence),
    debug: options?.debug ?? parseBool(envDebug) ?? false,
  }
}
