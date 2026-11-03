export { MAX_HTML_PREVIEW_BYTES, isHtmlPreviewFile } from "@alook/shared/html-preview"
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads"
export const HTML_PREVIEW_THEME_VARIABLES = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
  "accent", "accent-foreground", "border", "input", "ring", "destructive", "warning", "radius", "font-sans", "font-mono",
] as const
