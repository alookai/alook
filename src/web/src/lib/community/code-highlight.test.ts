import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShikiLanguage } from "./attachment-presentation"

const SUPPORTED_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "dotenv",
  "go",
  "graphql",
  "hcl",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "jsonl",
  "jsx",
  "kotlin",
  "log",
  "makefile",
  "mdx",
  "php",
  "proto",
  "python",
  "ruby",
  "rust",
  "scss",
  "sql",
  "svelte",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
] as const satisfies readonly ShikiLanguage[]

const shikiMocks = vi.hoisted(() => {
  const highlighter = {
    codeToTokensWithThemes: vi.fn(),
    getLoadedLanguages: vi.fn((): string[] => []),
    loadLanguage: vi.fn(async () => undefined),
  }
  return {
    createHighlighterCore: vi.fn(async () => highlighter),
    createOnigurumaEngine: vi.fn(() => ({ engine: true })),
    highlighter,
  }
})

vi.mock("@shikijs/core", () => ({
  createHighlighterCore: shikiMocks.createHighlighterCore,
}))

vi.mock("@shikijs/engine-oniguruma", () => ({
  createOnigurumaEngine: shikiMocks.createOnigurumaEngine,
}))

vi.mock("@shikijs/engine-oniguruma/wasm-inlined", () => ({ default: { wasm: true } }))

vi.mock("@shikijs/langs", () => ({
  get bundledLanguages() {
    throw new Error("Broad language registry must not load")
  },
}))

vi.mock("@shikijs/themes", () => ({
  get bundledThemes() {
    throw new Error("Broad theme registry must not load")
  },
}))

vi.mock("@shikijs/langs/json", () => ({ default: [{ id: "json" }] }))
vi.mock("@shikijs/langs/typescript", () => ({ default: [{ id: "typescript" }] }))
vi.mock("@shikijs/themes/github-light", () => ({ default: { name: "github-light" } }))
vi.mock("@shikijs/themes/github-dark", () => ({ default: { name: "github-dark" } }))

beforeEach(() => {
  vi.resetModules()
  shikiMocks.createHighlighterCore.mockClear()
  shikiMocks.createOnigurumaEngine.mockClear()
  shikiMocks.highlighter.codeToTokensWithThemes.mockReset()
  shikiMocks.highlighter.getLoadedLanguages.mockReset().mockReturnValue([])
  shikiMocks.highlighter.loadLanguage.mockReset().mockResolvedValue(undefined)
})

describe("highlightCode", () => {
  it("does not initialize Shiki for plain text", async () => {
    const { highlightCode } = await import("./code-highlight")
    await expect(highlightCode("hello", null)).resolves.toEqual({
      kind: "plain",
      lines: null,
      reason: null,
    })
    expect(shikiMocks.createHighlighterCore).not.toHaveBeenCalled()
  })

  it("lazily reuses one runtime and language load with light and dark tokens", async () => {
    shikiMocks.highlighter.codeToTokensWithThemes.mockReturnValue([[
      {
        content: "const",
        variants: {
          light: { color: "#111111", fontStyle: 1 },
          dark: { color: "#eeeeee", fontStyle: 1 },
        },
      },
    ]])
    const { highlightCode } = await import("./code-highlight")
    const [first, second] = await Promise.all([
      highlightCode("const", "typescript"),
      highlightCode("let", "typescript"),
    ])

    expect(shikiMocks.createHighlighterCore).toHaveBeenCalledTimes(1)
    expect(shikiMocks.createHighlighterCore).toHaveBeenCalledWith(expect.objectContaining({
      themes: [{ name: "github-light" }, { name: "github-dark" }],
    }))
    expect(shikiMocks.highlighter.loadLanguage).toHaveBeenCalledTimes(1)
    expect(shikiMocks.highlighter.loadLanguage).toHaveBeenCalledWith({ id: "typescript" })
    expect(shikiMocks.highlighter.codeToTokensWithThemes).toHaveBeenCalledWith("const", {
      lang: "typescript",
      themes: { light: "github-light", dark: "github-dark" },
    })
    expect(first).toEqual({
      kind: "highlighted",
      lines: [[{
        content: "const",
        light: { color: "#111111", fontStyle: 1 },
        dark: { color: "#eeeeee", fontStyle: 1 },
      }]],
      reason: null,
    })
    expect(second.kind).toBe("highlighted")
  })

  it("resolves every supported language through its explicit package entry", async () => {
    shikiMocks.highlighter.codeToTokensWithThemes.mockReturnValue([])
    const { highlightCode } = await import("./code-highlight")

    await Promise.all(SUPPORTED_LANGUAGES.map((language) => highlightCode("source", language)))

    expect(shikiMocks.highlighter.loadLanguage).toHaveBeenCalledTimes(SUPPORTED_LANGUAGES.length)
    expect(shikiMocks.highlighter.codeToTokensWithThemes).toHaveBeenCalledTimes(SUPPORTED_LANGUAGES.length)
  })

  it("skips Shiki above the byte or line token budget", async () => {
    const {
      highlightCode,
      MAX_CODE_HIGHLIGHT_BYTES,
      MAX_CODE_HIGHLIGHT_LINES,
    } = await import("./code-highlight")

    await expect(highlightCode("é".repeat(MAX_CODE_HIGHLIGHT_BYTES / 2 + 1), "json"))
      .resolves.toEqual({
        kind: "plain",
        lines: null,
        reason: "Syntax highlighting disabled for large files",
      })
    await expect(highlightCode("line\n".repeat(MAX_CODE_HIGHLIGHT_LINES), "json"))
      .resolves.toEqual({
        kind: "plain",
        lines: null,
        reason: "Syntax highlighting disabled for long files",
      })
    expect(shikiMocks.createHighlighterCore).not.toHaveBeenCalled()
  })

  it("keeps readable plain text when a grammar or tokenizer fails", async () => {
    const { highlightCode } = await import("./code-highlight")

    await expect(highlightCode("source", "missing" as "json")).resolves.toEqual({
      kind: "plain",
      lines: null,
      reason: "Syntax highlighting unavailable",
    })

    shikiMocks.highlighter.codeToTokensWithThemes.mockImplementation(() => {
      throw new Error("tokenizer failed")
    })
    await expect(highlightCode("{}", "json")).resolves.toEqual({
      kind: "plain",
      lines: null,
      reason: "Syntax highlighting unavailable",
    })
  })
})
