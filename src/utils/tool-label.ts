export interface ToolLabelInput {
  eventName?: string
  toolName?: string
  command?: string
}

const EDITING_TOOLS = new Set(["edit", "write", "replace", "multiedit"])
const READING_TOOLS = new Set(["read", "view"])
const SEARCHING_TOOLS = new Set(["grep", "glob", "search", "find"])

function normalizeName(value?: string): string {
  return value?.trim().toLowerCase() ?? ""
}

function getCommandLabel(command?: string): string {
  const normalized = normalizeName(command)

  if (/\b(test|vitest|jest|bun test|npm test|pnpm test)\b/.test(normalized)) {
    return "Running tests"
  }

  if (/\b(build|tsc\b|bun build|npm run build|pnpm build)\b/.test(normalized)) {
    return "Building"
  }

  if (normalized) {
    return "Executing"
  }

  return ""
}

export function getToolLabel(input: ToolLabelInput): string {
  const eventName = normalizeName(input.eventName)
  const toolName = normalizeName(input.toolName)

  if (eventName === "file.edited") {
    return "Editing"
  }

  if (eventName === "lsp.client.diagnostics") {
    return "Diagnosing"
  }

  if (READING_TOOLS.has(toolName)) {
    return "Reading"
  }

  if (EDITING_TOOLS.has(toolName)) {
    return "Editing"
  }

  if (SEARCHING_TOOLS.has(toolName)) {
    return "Searching"
  }

  if (toolName === "bash" || toolName === "shell" || input.command) {
    return getCommandLabel(input.command) || "Executing"
  }

  return "Working"
}
