export const MAX_TEXT_ATTACHMENT_PREVIEW_BYTES = 1024 * 1024

export type AttachmentCategory =
  | "image"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "text"
  | "code"
  | "audio"
  | "video"
  | "archive"
  | "unknown"

export type AttachmentPreviewKind = "markdown" | "text" | "code"

export type AttachmentPresentation = {
  category: AttachmentCategory
  previewKind: AttachmentPreviewKind | null
}

const GENERIC_CONTENT_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"])

const MIME_PRESENTATIONS: ReadonlyArray<{
  matches: (contentType: string) => boolean
  category: AttachmentCategory
  previewKind?: AttachmentPreviewKind
}> = [
  { matches: (type) => type === "text/markdown" || type === "text/x-markdown", category: "text", previewKind: "markdown" },
  { matches: (type) => type === "application/json" || type.endsWith("+json"), category: "code", previewKind: "code" },
  { matches: (type) => [
    "application/javascript",
    "application/typescript",
    "application/sql",
    "application/toml",
    "application/x-yaml",
    "application/yaml",
    "application/xml",
    "text/css",
    "text/javascript",
    "text/typescript",
    "text/x-python",
    "text/x-shellscript",
    "text/x-sql",
    "text/yaml",
  ].includes(type), category: "code", previewKind: "code" },
  { matches: (type) => type === "application/pdf", category: "pdf" },
  { matches: (type) => type.includes("spreadsheet") || type.includes("excel") || type === "text/csv", category: "spreadsheet" },
  { matches: (type) => type.includes("presentation") || type.includes("powerpoint"), category: "presentation" },
  { matches: (type) => type.includes("wordprocessing") || type === "application/msword" || type === "application/rtf", category: "document" },
  { matches: (type) => type.startsWith("audio/"), category: "audio" },
  { matches: (type) => type.startsWith("video/"), category: "video" },
  { matches: (type) => type.startsWith("image/"), category: "image" },
  { matches: (type) => type === "application/zip" || type === "application/x-7z-compressed" || type === "application/x-rar-compressed" || type === "application/gzip" || type === "application/x-tar", category: "archive" },
  { matches: (type) => type.startsWith("text/") && type !== "text/html", category: "text", previewKind: "text" },
]

const EXTENSION_PRESENTATIONS: Readonly<Record<string, AttachmentPresentation>> = {
  md: { category: "text", previewKind: "markdown" },
  markdown: { category: "text", previewKind: "markdown" },
  txt: { category: "text", previewKind: "text" },
  log: { category: "text", previewKind: "text" },
  csv: { category: "spreadsheet", previewKind: null },
  json: { category: "code", previewKind: "code" },
  jsonl: { category: "code", previewKind: "code" },
  js: { category: "code", previewKind: "code" },
  jsx: { category: "code", previewKind: "code" },
  ts: { category: "code", previewKind: "code" },
  tsx: { category: "code", previewKind: "code" },
  css: { category: "code", previewKind: "code" },
  scss: { category: "code", previewKind: "code" },
  sql: { category: "code", previewKind: "code" },
  sh: { category: "code", previewKind: "code" },
  bash: { category: "code", previewKind: "code" },
  py: { category: "code", previewKind: "code" },
  rb: { category: "code", previewKind: "code" },
  go: { category: "code", previewKind: "code" },
  rs: { category: "code", previewKind: "code" },
  java: { category: "code", previewKind: "code" },
  c: { category: "code", previewKind: "code" },
  h: { category: "code", previewKind: "code" },
  cpp: { category: "code", previewKind: "code" },
  yaml: { category: "code", previewKind: "code" },
  yml: { category: "code", previewKind: "code" },
  toml: { category: "code", previewKind: "code" },
  ini: { category: "code", previewKind: "code" },
  conf: { category: "code", previewKind: "code" },
  env: { category: "code", previewKind: "code" },
  xml: { category: "code", previewKind: "code" },
  pdf: { category: "pdf", previewKind: null },
  doc: { category: "document", previewKind: null },
  docx: { category: "document", previewKind: null },
  rtf: { category: "document", previewKind: null },
  xls: { category: "spreadsheet", previewKind: null },
  xlsx: { category: "spreadsheet", previewKind: null },
  ppt: { category: "presentation", previewKind: null },
  pptx: { category: "presentation", previewKind: null },
  mp3: { category: "audio", previewKind: null },
  wav: { category: "audio", previewKind: null },
  m4a: { category: "audio", previewKind: null },
  mp4: { category: "video", previewKind: null },
  mov: { category: "video", previewKind: null },
  webm: { category: "video", previewKind: null },
  zip: { category: "archive", previewKind: null },
  gz: { category: "archive", previewKind: null },
  tar: { category: "archive", previewKind: null },
  rar: { category: "archive", previewKind: null },
  "7z": { category: "archive", previewKind: null },
  png: { category: "image", previewKind: null },
  jpg: { category: "image", previewKind: null },
  jpeg: { category: "image", previewKind: null },
  gif: { category: "image", previewKind: null },
  webp: { category: "image", previewKind: null },
  svg: { category: "image", previewKind: null },
  html: { category: "code", previewKind: null },
  htm: { category: "code", previewKind: null },
}

function filenameExtension(filename: string): string {
  const basename = filename.toLowerCase().split(/[\\/]/).pop() ?? ""
  if (basename.startsWith(".env")) return "env"
  const dot = basename.lastIndexOf(".")
  return dot > -1 ? basename.slice(dot + 1) : ""
}

export function resolveAttachmentPresentation(
  filename: string,
  contentType?: string | null,
): AttachmentPresentation {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (!GENERIC_CONTENT_TYPES.has(normalizedType)) {
    for (const presentation of MIME_PRESENTATIONS) {
      if (presentation.matches(normalizedType)) {
        return {
          category: presentation.category,
          previewKind: presentation.previewKind ?? null,
        }
      }
    }
    return { category: "unknown", previewKind: null }
  }
  return EXTENSION_PRESENTATIONS[filenameExtension(filename)] ?? {
    category: "unknown",
    previewKind: null,
  }
}

export function formatAttachmentSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
