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

type AttachmentPreviewKind = "markdown" | "text" | "code"

export type ShikiLanguage =
  | "bash"
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "diff"
  | "dockerfile"
  | "dotenv"
  | "go"
  | "graphql"
  | "hcl"
  | "html"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "jsonl"
  | "jsx"
  | "kotlin"
  | "log"
  | "makefile"
  | "mdx"
  | "php"
  | "proto"
  | "python"
  | "ruby"
  | "rust"
  | "scss"
  | "sql"
  | "svelte"
  | "swift"
  | "toml"
  | "tsx"
  | "typescript"
  | "vue"
  | "xml"
  | "yaml"

export type AttachmentPresentation = {
  category: AttachmentCategory
  previewKind: AttachmentPreviewKind | null
  shikiLanguage: ShikiLanguage | null
}

const GENERIC_CONTENT_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"])

const MEDIA_EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
}

const MIME_PRESENTATIONS: ReadonlyArray<{
  matches: (contentType: string) => boolean
  presentation: AttachmentPresentation
}> = [
  { matches: (type) => type === "text/markdown" || type === "text/x-markdown", presentation: { category: "text", previewKind: "markdown", shikiLanguage: null } },
  { matches: (type) => type === "text/mdx" || type === "application/mdx", presentation: { category: "code", previewKind: "code", shikiLanguage: "mdx" } },
  { matches: (type) => type === "text/html" || type === "application/xhtml+xml", presentation: { category: "code", previewKind: "code", shikiLanguage: "html" } },
  { matches: (type) => type === "image/svg+xml", presentation: { category: "code", previewKind: "code", shikiLanguage: "xml" } },
  { matches: (type) => type === "application/json" || type.endsWith("+json"), presentation: { category: "code", previewKind: "code", shikiLanguage: "json" } },
  { matches: (type) => type === "application/xml" || type === "text/xml" || type.endsWith("+xml"), presentation: { category: "code", previewKind: "code", shikiLanguage: "xml" } },
  { matches: (type) => ["application/javascript", "text/javascript"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "javascript" } },
  { matches: (type) => ["application/typescript", "text/typescript"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "typescript" } },
  { matches: (type) => type === "text/css", presentation: { category: "code", previewKind: "code", shikiLanguage: "css" } },
  { matches: (type) => type === "text/x-scss", presentation: { category: "code", previewKind: "code", shikiLanguage: "scss" } },
  { matches: (type) => ["application/sql", "text/x-sql"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "sql" } },
  { matches: (type) => ["application/toml", "text/toml"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "toml" } },
  { matches: (type) => ["application/x-yaml", "application/yaml", "text/yaml", "text/x-yaml"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "yaml" } },
  { matches: (type) => ["application/x-sh", "text/x-shellscript"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "bash" } },
  { matches: (type) => type === "text/x-python", presentation: { category: "code", previewKind: "code", shikiLanguage: "python" } },
  { matches: (type) => type === "text/x-ruby", presentation: { category: "code", previewKind: "code", shikiLanguage: "ruby" } },
  { matches: (type) => type === "text/x-go", presentation: { category: "code", previewKind: "code", shikiLanguage: "go" } },
  { matches: (type) => type === "text/x-rust", presentation: { category: "code", previewKind: "code", shikiLanguage: "rust" } },
  { matches: (type) => type === "text/x-java-source", presentation: { category: "code", previewKind: "code", shikiLanguage: "java" } },
  { matches: (type) => ["text/x-c", "text/x-csrc"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "c" } },
  { matches: (type) => ["text/x-c++", "text/x-c++src"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "cpp" } },
  { matches: (type) => ["text/x-csharp", "text/x-cs"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "csharp" } },
  { matches: (type) => type === "application/x-httpd-php", presentation: { category: "code", previewKind: "code", shikiLanguage: "php" } },
  { matches: (type) => type === "text/x-kotlin", presentation: { category: "code", previewKind: "code", shikiLanguage: "kotlin" } },
  { matches: (type) => type === "text/x-swift", presentation: { category: "code", previewKind: "code", shikiLanguage: "swift" } },
  { matches: (type) => ["application/graphql", "text/graphql"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "graphql" } },
  { matches: (type) => ["application/protobuf", "application/x-protobuf", "text/x-proto"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "proto" } },
  { matches: (type) => ["application/x-terraform", "text/x-hcl"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "hcl" } },
  { matches: (type) => ["text/x-diff", "text/x-patch"].includes(type), presentation: { category: "code", previewKind: "code", shikiLanguage: "diff" } },
  { matches: (type) => type === "text/x-log", presentation: { category: "code", previewKind: "code", shikiLanguage: "log" } },
  { matches: (type) => type === "application/pdf", presentation: { category: "pdf", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.includes("spreadsheet") || type.includes("excel") || type === "text/csv" || type === "text/tab-separated-values", presentation: { category: "spreadsheet", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.includes("presentation") || type.includes("powerpoint"), presentation: { category: "presentation", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.includes("wordprocessing") || type === "application/msword" || type === "application/rtf", presentation: { category: "document", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.startsWith("audio/"), presentation: { category: "audio", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.startsWith("video/"), presentation: { category: "video", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.startsWith("image/"), presentation: { category: "image", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type === "application/zip" || type === "application/x-7z-compressed" || type === "application/x-rar-compressed" || type === "application/gzip" || type === "application/x-tar", presentation: { category: "archive", previewKind: null, shikiLanguage: null } },
  { matches: (type) => type.startsWith("text/"), presentation: { category: "text", previewKind: "text", shikiLanguage: null } },
]

const code = (shikiLanguage: ShikiLanguage): AttachmentPresentation => ({
  category: "code",
  previewKind: "code",
  shikiLanguage,
})

const EXTENSION_PRESENTATIONS: Readonly<Record<string, AttachmentPresentation>> = {
  md: { category: "text", previewKind: "markdown", shikiLanguage: null },
  markdown: { category: "text", previewKind: "markdown", shikiLanguage: null },
  txt: { category: "text", previewKind: "text", shikiLanguage: null },
  log: code("log"),
  csv: { category: "spreadsheet", previewKind: null, shikiLanguage: null },
  tsv: { category: "spreadsheet", previewKind: null, shikiLanguage: null },
  json: code("json"),
  jsonl: code("jsonl"),
  js: code("javascript"),
  mjs: code("javascript"),
  cjs: code("javascript"),
  jsx: code("jsx"),
  ts: code("typescript"),
  mts: code("typescript"),
  cts: code("typescript"),
  tsx: code("tsx"),
  css: code("css"),
  scss: code("scss"),
  sql: code("sql"),
  sh: code("bash"),
  bash: code("bash"),
  zsh: code("bash"),
  py: code("python"),
  rb: code("ruby"),
  go: code("go"),
  rs: code("rust"),
  java: code("java"),
  c: code("c"),
  h: code("c"),
  cc: code("cpp"),
  cpp: code("cpp"),
  cxx: code("cpp"),
  hpp: code("cpp"),
  cs: code("csharp"),
  php: code("php"),
  kt: code("kotlin"),
  kts: code("kotlin"),
  swift: code("swift"),
  vue: code("vue"),
  svelte: code("svelte"),
  graphql: code("graphql"),
  gql: code("graphql"),
  proto: code("proto"),
  tf: code("hcl"),
  tfvars: code("hcl"),
  hcl: code("hcl"),
  diff: code("diff"),
  patch: code("diff"),
  yaml: code("yaml"),
  yml: code("yaml"),
  toml: code("toml"),
  ini: code("ini"),
  conf: code("ini"),
  config: code("ini"),
  properties: code("ini"),
  env: code("dotenv"),
  xml: code("xml"),
  html: code("html"),
  htm: code("html"),
  svg: code("xml"),
  mdx: code("mdx"),
  pdf: { category: "pdf", previewKind: null, shikiLanguage: null },
  doc: { category: "document", previewKind: null, shikiLanguage: null },
  docx: { category: "document", previewKind: null, shikiLanguage: null },
  rtf: { category: "document", previewKind: null, shikiLanguage: null },
  xls: { category: "spreadsheet", previewKind: null, shikiLanguage: null },
  xlsx: { category: "spreadsheet", previewKind: null, shikiLanguage: null },
  ppt: { category: "presentation", previewKind: null, shikiLanguage: null },
  pptx: { category: "presentation", previewKind: null, shikiLanguage: null },
  mp3: { category: "audio", previewKind: null, shikiLanguage: null },
  wav: { category: "audio", previewKind: null, shikiLanguage: null },
  m4a: { category: "audio", previewKind: null, shikiLanguage: null },
  ogg: { category: "audio", previewKind: null, shikiLanguage: null },
  mp4: { category: "video", previewKind: null, shikiLanguage: null },
  mov: { category: "video", previewKind: null, shikiLanguage: null },
  webm: { category: "video", previewKind: null, shikiLanguage: null },
  zip: { category: "archive", previewKind: null, shikiLanguage: null },
  gz: { category: "archive", previewKind: null, shikiLanguage: null },
  tar: { category: "archive", previewKind: null, shikiLanguage: null },
  rar: { category: "archive", previewKind: null, shikiLanguage: null },
  "7z": { category: "archive", previewKind: null, shikiLanguage: null },
  png: { category: "image", previewKind: null, shikiLanguage: null },
  jpg: { category: "image", previewKind: null, shikiLanguage: null },
  jpeg: { category: "image", previewKind: null, shikiLanguage: null },
  gif: { category: "image", previewKind: null, shikiLanguage: null },
  webp: { category: "image", previewKind: null, shikiLanguage: null },
}

const BASENAME_PRESENTATIONS: Readonly<Record<string, AttachmentPresentation>> = {
  dockerfile: code("dockerfile"),
  makefile: code("makefile"),
  gnumakefile: code("makefile"),
}

function filenameParts(filename: string): { basename: string; extension: string } {
  const basename = filename.toLowerCase().split(/[\\/]/).pop() ?? ""
  if (basename.startsWith(".env")) return { basename, extension: "env" }
  const dot = basename.lastIndexOf(".")
  return { basename, extension: dot > -1 ? basename.slice(dot + 1) : "" }
}

export function resolveAttachmentPresentation(
  filename: string,
  contentType?: string | null,
): AttachmentPresentation {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (!GENERIC_CONTENT_TYPES.has(normalizedType)) {
    for (const { matches, presentation } of MIME_PRESENTATIONS) {
      if (matches(normalizedType)) return presentation
    }
    return { category: "unknown", previewKind: null, shikiLanguage: null }
  }
  const { basename, extension } = filenameParts(filename)
  return BASENAME_PRESENTATIONS[basename]
    ?? EXTENSION_PRESENTATIONS[extension]
    ?? { category: "unknown", previewKind: null, shikiLanguage: null }
}

export function resolveMediaContentType(
  filename: string,
  contentType?: string | null,
): string | null {
  const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (normalizedType.startsWith("audio/") || normalizedType.startsWith("video/")) {
    return normalizedType
  }
  if (!GENERIC_CONTENT_TYPES.has(normalizedType)) return null
  return MEDIA_EXTENSION_CONTENT_TYPES[filenameParts(filename).extension] ?? null
}

export function formatAttachmentSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
