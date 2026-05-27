export const MAX_FILE_LABEL_LENGTH = 42

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+/g, "/")
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function getBasename(value: string): string {
  const normalized = trimTrailingSlash(normalizePath(value))
  const parts = normalized.split("/")
  return parts[parts.length - 1] ?? normalized
}

function getExtensionParts(filename: string): { stem: string; extension: string } {
  const firstDot = filename.startsWith(".") ? filename.indexOf(".", 1) : filename.indexOf(".")
  if (firstDot <= 0) {
    return { stem: filename, extension: "" }
  }

  return {
    stem: filename.slice(0, firstDot),
    extension: filename.slice(firstDot),
  }
}

export function truncateFileLabel(label: string, maxLength = MAX_FILE_LABEL_LENGTH): string {
  if (label.length <= maxLength) {
    return label
  }

  const normalized = normalizePath(label)
  const lastSlashIndex = normalized.lastIndexOf("/")

  if (lastSlashIndex > 0) {
    const dirname = normalized.slice(0, lastSlashIndex)
    const basename = normalized.slice(lastSlashIndex + 1)

    if (basename.length + 2 < maxLength) {
      const prefixBudget = maxLength - basename.length - 2
      const prefix = dirname.slice(0, prefixBudget)
      if (prefix.length > 0) {
        return `${prefix}…/${basename}`
      }
    }
  }

  const basename = getBasename(normalized)
  const { stem, extension } = getExtensionParts(basename)

  if (extension && extension.length + 1 < maxLength) {
    const stemBudget = maxLength - extension.length - 1
    return `${stem.slice(0, stemBudget)}…${extension}`
  }

  return `${normalized.slice(0, maxLength - 1)}…`
}

export function formatFileLabel(
  filePath: string,
  workspaceRoot?: string,
  maxLength = MAX_FILE_LABEL_LENGTH,
): string {
  const normalizedPath = trimTrailingSlash(normalizePath(filePath))
  const normalizedWorkspaceRoot = workspaceRoot
    ? trimTrailingSlash(normalizePath(workspaceRoot))
    : ""

  let label = getBasename(normalizedPath)

  if (normalizedWorkspaceRoot) {
    const comparablePath = normalizedPath.toLowerCase()
    const comparableRoot = normalizedWorkspaceRoot.toLowerCase()

    if (comparablePath.startsWith(`${comparableRoot}/`)) {
      label = normalizedPath.slice(normalizedWorkspaceRoot.length + 1)
    }
  }

  return truncateFileLabel(label, maxLength)
}
