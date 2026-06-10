import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscordPresenceOptions } from "./types/index.js"

export interface ConfigParseError {
  path: string
  error: unknown
}

export interface LoadConfigResult {
  options?: DiscordPresenceOptions
  parseError?: ConfigParseError
}

/**
 * Reads `.discord-presence.json` from the project directory, then the home
 * directory. A malformed file is skipped (fall back to the next source) but
 * reported via `parseError` so the caller can surface it once the debug gate
 * is resolvable — logging here directly would bypass the gate, since `debug`
 * itself lives in the config that failed to parse.
 */
export async function loadConfigFile(
  directory: string,
  home: string = homedir(),
): Promise<LoadConfigResult> {
  const paths = [join(directory, ".discord-presence.json"), join(home, ".discord-presence.json")]

  let parseError: ConfigParseError | undefined

  for (const configPath of paths) {
    try {
      const content = await readFile(configPath, "utf-8")
      return { options: JSON.parse(content) as DiscordPresenceOptions, parseError }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      parseError ??= { path: configPath, error }
    }
  }
  return { parseError }
}
