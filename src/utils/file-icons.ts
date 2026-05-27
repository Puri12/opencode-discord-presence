const LANGUAGE_ICON_MAP: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  json: "json",
  markdown: "markdown",
  yaml: "yaml",
  html: "html",
  css: "css",
}

const EXTENSION_ICON_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  html: "html",
  css: "css",
}

export const GENERIC_FILE_ICON = "file"

function getExtension(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/")
  const basename = normalized.split("/").pop() ?? normalized
  const lastDot = basename.lastIndexOf(".")

  if (lastDot <= 0) {
    return ""
  }

  return basename.slice(lastDot + 1).toLowerCase()
}

export function getFileIconKey(filePath: string, language?: string): string {
  const normalizedLanguage = language?.trim().toLowerCase()
  if (normalizedLanguage && LANGUAGE_ICON_MAP[normalizedLanguage]) {
    return LANGUAGE_ICON_MAP[normalizedLanguage]
  }

  const extension = getExtension(filePath)
  return EXTENSION_ICON_MAP[extension] ?? GENERIC_FILE_ICON
}
