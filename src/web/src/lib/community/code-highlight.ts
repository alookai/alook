import type { ShikiLanguage } from "./attachment-presentation"
import type { LanguageRegistration } from "@shikijs/core"

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
  bash: () => import("@shikijs/langs/bash").then((module) => module.default),
  c: () => import("@shikijs/langs/c").then((module) => module.default),
  cpp: () => import("@shikijs/langs/cpp").then((module) => module.default),
  csharp: () => import("@shikijs/langs/csharp").then((module) => module.default),
  css: () => import("@shikijs/langs/css").then((module) => module.default),
  diff: () => import("@shikijs/langs/diff").then((module) => module.default),
  dockerfile: () => import("@shikijs/langs/dockerfile").then((module) => module.default),
  dotenv: () => import("@shikijs/langs/dotenv").then((module) => module.default),
  go: () => import("@shikijs/langs/go").then((module) => module.default),
  graphql: () => import("@shikijs/langs/graphql").then((module) => module.default),
  hcl: () => import("@shikijs/langs/hcl").then((module) => module.default),
  html: () => import("@shikijs/langs/html").then((module) => module.default),
  ini: () => import("@shikijs/langs/ini").then((module) => module.default),
  java: () => import("@shikijs/langs/java").then((module) => module.default),
  javascript: () => import("@shikijs/langs/javascript").then((module) => module.default),
  json: () => import("@shikijs/langs/json").then((module) => module.default),
  jsonl: () => import("@shikijs/langs/jsonl").then((module) => module.default),
  jsx: () => import("@shikijs/langs/jsx").then((module) => module.default),
  kotlin: () => import("@shikijs/langs/kotlin").then((module) => module.default),
  log: () => import("@shikijs/langs/log").then((module) => module.default),
  makefile: () => import("@shikijs/langs/makefile").then((module) => module.default),
  mdx: () => import("@shikijs/langs/mdx").then((module) => module.default),
  php: () => import("@shikijs/langs/php").then((module) => module.default),
  proto: () => import("@shikijs/langs/proto").then((module) => module.default),
  python: () => import("@shikijs/langs/python").then((module) => module.default),
  ruby: () => import("@shikijs/langs/ruby").then((module) => module.default),
  rust: () => import("@shikijs/langs/rust").then((module) => module.default),
  scss: () => import("@shikijs/langs/scss").then((module) => module.default),
  sql: () => import("@shikijs/langs/sql").then((module) => module.default),
  svelte: () => import("@shikijs/langs/svelte").then((module) => module.default),
  swift: () => import("@shikijs/langs/swift").then((module) => module.default),
  toml: () => import("@shikijs/langs/toml").then((module) => module.default),
  tsx: () => import("@shikijs/langs/tsx").then((module) => module.default),
  typescript: () => import("@shikijs/langs/typescript").then((module) => module.default),
  vue: () => import("@shikijs/langs/vue").then((module) => module.default),
  xml: () => import("@shikijs/langs/xml").then((module) => module.default),
  yaml: () => import("@shikijs/langs/yaml").then((module) => module.default),
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
    import("@shikijs/core"),
    import("@shikijs/engine-oniguruma"),
    import("@shikijs/engine-oniguruma/wasm-inlined"),
    import("@shikijs/themes/github-light").then((module) => module.default),
    import("@shikijs/themes/github-dark").then((module) => module.default),
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
