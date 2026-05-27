import { describe, expect, test } from "bun:test"
import { getToolLabel } from "./tool-label"

describe("getToolLabel", () => {
  test("maps file edited events to Editing", () => {
    expect(getToolLabel({ eventName: "file.edited" })).toBe("Editing")
  })

  test("maps read-like tools to Reading", () => {
    expect(getToolLabel({ toolName: "Read" })).toBe("Reading")
  })

  test("maps search-like tools to Searching", () => {
    expect(getToolLabel({ toolName: "Grep" })).toBe("Searching")
  })

  test("maps test commands to Running tests", () => {
    expect(
      getToolLabel({ toolName: "Bash", command: "bun test src/utils/tool-label.test.ts" }),
    ).toBe("Running tests")
  })

  test("maps build commands to Building", () => {
    expect(getToolLabel({ toolName: "Bash", command: "bun run build" })).toBe("Building")
  })

  test("maps diagnostics events to Diagnosing", () => {
    expect(getToolLabel({ eventName: "lsp.client.diagnostics" })).toBe("Diagnosing")
  })

  test("falls back to Working for unknown tools", () => {
    expect(getToolLabel({ toolName: "TotallyUnknownThing" })).toBe("Working")
  })
})
