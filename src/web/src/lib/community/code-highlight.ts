import type { ShikiLanguage } from "./attachment-presentation"
import type { LanguageRegistration } from "shiki/core"

export const MAX_CODE_HIGHLIGHT_BYTES = 256 * 1024
export const MAX_CODE_HIGHLIGHT_LINES = 2_000

type CodeTokenStyle = {
  color?: string
  fontStyle?: number
}

export type CodeToken = {
  content: string
  light: CodeTokenStyle
  dark: CodeTokenStyle
}

export type CodeHighlightResult =
  | { kind: "highlighted"; lines: CodeToken[][]; reason: null }
  | { kind: "plain"; lines: null; reason: string | null }

type Runtime = {
  highlighter: {
    codeToTokensWithThemes: (
      content: string,
      options: { lang: string; themes: { light: string; dark: string } },
    ) => Array<Array<{
      content: string
      variants: Record<string, CodeTokenStyle>
    }>>
    getLoadedLanguages: () => string[]
    loadLanguage: (...languages: unknown[]) => Promise<void>
  }
}

let runtimePromise: Promise<Runtime> | null = null
const languageLoads = new Map<ShikiLanguage, Promise<void>>()

const LANGUAGE_LOADERS = {
  bash: () => import("shiki/langs/bash.mjs").then((module) => module.default),
  c: () => import("shiki/langs/c.mjs").then((module) => module.default),
  cpp: () => import("shiki/langs/cpp.mjs").then((module) => module.default),
  csharp: () => import("shiki/langs/csharp.mjs").then((module) => module.default),
  css: () => import("shiki/langs/css.mjs").then((module) => module.default),
  diff: () => import("shiki/langs/diff.mjs").then((module) => module.default),
  dockerfile: () => import("shiki/langs/dockerfile.mjs").then((module) => module.default),
  dotenv: () => import("shiki/langs/dotenv.mjs").then((module) => module.default),
  go: () => import("shiki/langs/go.mjs").then((module) => module.default),
  graphql: () => import("shiki/langs/graphql.mjs").then((module) => module.default),
  hcl: () => import("shiki/langs/hcl.mjs").then((module) => module.default),
  html: () => import("shiki/langs/html.mjs").then((module) => module.default),
  ini: () => import("shiki/langs/ini.mjs").then((module) => module.default),
  java: () => import("shiki/langs/java.mjs").then((module) => module.default),
  javascript: () => import("shiki/langs/javascript.mjs").then((module) => module.default),
  json: () => import("shiki/langs/json.mjs").then((module) => module.default),
  jsonl: () => import("shiki/langs/jsonl.mjs").then((module) => module.default),
  jsx: () => import("shiki/langs/jsx.mjs").then((module) => module.default),
  kotlin: () => import("shiki/langs/kotlin.mjs").then((module) => module.default),
  log: () => import("shiki/langs/log.mjs").then((module) => module.default),
  makefile: () => import("shiki/langs/makefile.mjs").then((module) => module.default),
  mdx: () => import("shiki/langs/mdx.mjs").then((module) => module.default),
  php: () => import("shiki/langs/php.mjs").then((module) => module.default),
  proto: () => import("shiki/langs/proto.mjs").then((module) => module.default),
  python: () => import("shiki/langs/python.mjs").then((module) => module.default),
  ruby: () => import("shiki/langs/ruby.mjs").then((module) => module.default),
  rust: () => import("shiki/langs/rust.mjs").then((module) => module.default),
  scss: () => import("shiki/langs/scss.mjs").then((module) => module.default),
  sql: () => import("shiki/langs/sql.mjs").then((module) => module.default),
  svelte: () => import("shiki/langs/svelte.mjs").then((module) => module.default),
  swift: () => import("shiki/langs/swift.mjs").then((module) => module.default),
  toml: () => import("shiki/langs/toml.mjs").then((module) => module.default),
  tsx: () => import("shiki/langs/tsx.mjs").then((module) => module.default),
  typescript: () => import("shiki/langs/typescript.mjs").then((module) => module.default),
  vue: () => import("shiki/langs/vue.mjs").then((module) => module.default),
  xml: () => import("shiki/langs/xml.mjs").then((module) => module.default),
  yaml: () => import("shiki/langs/yaml.mjs").then((module) => module.default),
} satisfies Record<ShikiLanguage, () => Promise<LanguageRegistration[]>>

function lineCount(content: string): number {
  if (content.length === 0) return 1
  let count = 1
  for (const character of content) {
    if (character === "\n") count += 1
  }
  return count
}

function codeHighlightBudgetReason(content: string): string | null {
  if (new TextEncoder().encode(content).byteLength > MAX_CODE_HIGHLIGHT_BYTES) {
    return "Syntax highlighting disabled for large files"
  }
  if (lineCount(content) > MAX_CODE_HIGHLIGHT_LINES) {
    return "Syntax highlighting disabled for long files"
  }
  return null
}

async function createRuntime(): Promise<Runtime> {
  const [core, engine, wasm, lightTheme, darkTheme] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
    import("shiki/wasm"),
    import("shiki/themes/github-light.mjs").then((module) => module.default),
    import("shiki/themes/github-dark.mjs").then((module) => module.default),
  ])
  const highlighter = await core.createHighlighterCore({
    engine: engine.createOnigurumaEngine(wasm.default),
    themes: [lightTheme, darkTheme],
    langs: [],
    warnings: false,
  })
  return { highlighter } as Runtime
}

async function getRuntime(): Promise<Runtime> {
  runtimePromise ??= createRuntime()
  return runtimePromise
}

async function ensureLanguage(runtime: Runtime, language: ShikiLanguage): Promise<void> {
  if (runtime.highlighter.getLoadedLanguages().includes(language)) return
  let pending = languageLoads.get(language)
  if (!pending) {
    pending = LANGUAGE_LOADERS[language]()
      .then((registrations) => runtime.highlighter.loadLanguage(...registrations))
    languageLoads.set(language, pending)
  }
  try {
    await pending
  } catch (error) {
    languageLoads.delete(language)
    throw error
  }
}

export async function highlightCode(
  content: string,
  language: ShikiLanguage | null,
): Promise<CodeHighlightResult> {
  if (!language) return { kind: "plain", lines: null, reason: null }
  const budgetReason = codeHighlightBudgetReason(content)
  if (budgetReason) return { kind: "plain", lines: null, reason: budgetReason }
  try {
    const runtime = await getRuntime()
    await ensureLanguage(runtime, language)
    const lines = runtime.highlighter.codeToTokensWithThemes(content, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
    }).map((line) => line.map((token) => ({
      content: token.content,
      light: token.variants.light ?? {},
      dark: token.variants.dark ?? {},
    })))
    return { kind: "highlighted", lines, reason: null }
  } catch {
    return {
      kind: "plain",
      lines: null,
      reason: "Syntax highlighting unavailable",
    }
  }
}
