import { describe, expect, test } from "bun:test"
import { GENERIC_FILE_ICON, getFileIconKey } from "./file-icons"
import { formatFileLabel, MAX_FILE_LABEL_LENGTH } from "./file-label"

describe("formatFileLabel", () => {
  const workspaceRoot = "D:/coding_clone/opencode-discord-presence"

  test("uses a workspace-relative label when the file is inside the workspace", () => {
    expect(
      formatFileLabel(
        "D:/coding_clone/opencode-discord-presence/src/utils/file-label.ts",
        workspaceRoot,
      ),
    ).toBe("src/utils/file-label.ts")
  })

  test("falls back to the basename when the file is outside the workspace", () => {
    expect(
      formatFileLabel("C:/Users/frey/Documents/private-notes/secrets.txt", workspaceRoot),
    ).toBe("secrets.txt")
  })

  test("truncates long labels deterministically while keeping the full basename when possible", () => {
    const filePath =
      "D:/coding_clone/opencode-discord-presence/src/features/presence/components/activity-rotation.test.ts"

    const first = formatFileLabel(filePath, workspaceRoot)
    const second = formatFileLabel(filePath, workspaceRoot)

    expect(first).toBe(second)
    expect(first.length).toBeLessThanOrEqual(MAX_FILE_LABEL_LENGTH)
    expect(first).toContain("…")
    expect(first).toEndWith("/activity-rotation.test.ts")
  })

  test("truncates long basenames while preserving the extension when possible", () => {
    const label = formatFileLabel(
      "D:/coding_clone/opencode-discord-presence/src/averyveryveryveryverylongfilenamewithmeaningfulsuffix.test.ts",
      workspaceRoot,
      30,
    )

    expect(label.length).toBeLessThanOrEqual(30)
    expect(label).toContain("…")
    expect(label).toEndWith(".test.ts")
  })
})

describe("getFileIconKey", () => {
  test("maps curated extensions", () => {
    expect(getFileIconKey("src/plugin.ts")).toBe("typescript")
    expect(getFileIconKey("README.md")).toBe("markdown")
    expect(getFileIconKey("package.json")).toBe("json")
  })

  test("falls back to the generic icon for unknown files", () => {
    expect(getFileIconKey("notes.custom")).toBe(GENERIC_FILE_ICON)
  })
})
