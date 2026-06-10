import { normalizeFileIdentity } from "./session-metrics.js"

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recursive traversal of unknown arg shape needed
export function extractFilePathFromArgs(args?: unknown): string | undefined {
  if (!args) return undefined
  if (typeof args === "string") {
    const trimmed = args.trim()
    const quotedWithSingle = trimmed.startsWith("'") && trimmed.endsWith("'")
    const quotedWithDouble = trimmed.startsWith('"') && trimmed.endsWith('"')
    const wasQuoted = quotedWithSingle || quotedWithDouble
    const candidate = wasQuoted ? trimmed.slice(1, -1).trim() : trimmed

    if (!candidate || candidate.startsWith("-")) {
      return undefined
    }

    if (!(candidate.includes("/") || candidate.includes("\\"))) {
      return undefined
    }

    if (!wasQuoted && /\s/.test(candidate)) {
      return undefined
    }

    if (candidate.includes(" ")) {
      return undefined
    }

    return normalizeFileIdentity(candidate)
  }
  if (Array.isArray(args)) {
    for (const item of args) {
      const extracted = extractFilePathFromArgs(item)
      if (extracted) return extracted
    }
  }
  if (typeof args === "object") {
    for (const value of Object.values(args)) {
      const extracted = extractFilePathFromArgs(value)
      if (extracted) return extracted
    }
  }
  return undefined
}
