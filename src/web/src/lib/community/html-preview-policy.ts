export const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads"
export const HTML_PREVIEW_THEME_VARIABLES = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
  "accent", "accent-foreground", "border", "input", "ring", "destructive", "warning", "radius", "font-sans", "font-mono",
] as const

export function isHtmlPreviewFile(name: string, contentType?: string | null): boolean {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return type === "text/html" || (["", "application/octet-stream", "binary/octet-stream"].includes(type) && /\.html?$/i.test(name))
}
