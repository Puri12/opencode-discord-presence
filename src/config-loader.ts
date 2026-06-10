import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscordPresenceOptions } from "./types/index.js"

export async function loadConfigFile(
  directory: string,
): Promise<DiscordPresenceOptions | undefined> {
  const paths = [
    join(directory, ".discord-presence.json"),
    join(homedir(), ".discord-presence.json"),
  ]

  for (const configPath of paths) {
    try {
      const content = await readFile(configPath, "utf-8")
      return JSON.parse(content) as DiscordPresenceOptions
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      // Malformed config silently falls back to defaults. Logging here would
      // bypass the debug gate (debug itself is in the config we couldn't
      // parse), violating the "silent by default" promise. Users can verify
      // their config by passing the file through any JSON validator.
    }
  }
  return undefined
}
