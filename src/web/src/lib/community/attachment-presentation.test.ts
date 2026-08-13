import { describe, expect, it } from "vitest"
import {
  formatAttachmentSize,
  resolveAttachmentPresentation,
  type AttachmentPresentation,
} from "./attachment-presentation"

const presentation = (
  category: AttachmentPresentation["category"],
  previewKind: AttachmentPresentation["previewKind"],
  shikiLanguage: AttachmentPresentation["shikiLanguage"] = null,
): AttachmentPresentation => ({ category, previewKind, shikiLanguage })

describe("resolveAttachmentPresentation", () => {
  it.each([
    ["report.pdf", "application/pdf", presentation("pdf", null)],
    ["sheet.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", presentation("spreadsheet", null)],
    ["slides.bin", "application/vnd.ms-powerpoint", presentation("presentation", null)],
    ["voice.bin", "audio/mpeg", presentation("audio", null)],
    ["clip.bin", "video/mp4", presentation("video", null)],
    ["data.bin", "application/json; charset=utf-8", presentation("code", "code", "json")],
    ["readme.bin", "text/markdown", presentation("text", "markdown")],
    ["notes.bin", "text/plain", presentation("text", "text")],
    ["page.bin", "text/html", presentation("code", "code", "html")],
    ["vector.bin", "image/svg+xml", presentation("code", "code", "xml")],
    ["component.bin", "text/mdx", presentation("code", "code", "mdx")],
  ])("uses MIME for %s", (filename, contentType, expected) => {
    expect(resolveAttachmentPresentation(filename, contentType)).toEqual(expected)
  })

  it.each([
    ["README.md", undefined, presentation("text", "markdown")],
    ["config.json", "application/octet-stream", presentation("code", "code", "json")],
    [".env.local", "", presentation("code", "code", "dotenv")],
    ["Dockerfile", "binary/octet-stream", presentation("code", "code", "dockerfile")],
    ["GNUmakefile", undefined, presentation("code", "code", "makefile")],
    ["deck.pptx", undefined, presentation("presentation", null)],
    ["bundle.zip", "binary/octet-stream", presentation("archive", null)],
  ])("falls back to the filename for generic MIME: %s", (filename, contentType, expected) => {
    expect(resolveAttachmentPresentation(filename, contentType)).toEqual(expected)
  })

  it.each([
    ["js", "javascript"],
    ["jsx", "jsx"],
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["css", "css"],
    ["scss", "scss"],
    ["sql", "sql"],
    ["sh", "bash"],
    ["py", "python"],
    ["rb", "ruby"],
    ["go", "go"],
    ["rs", "rust"],
    ["java", "java"],
    ["c", "c"],
    ["h", "c"],
    ["cpp", "cpp"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["toml", "toml"],
    ["ini", "ini"],
    ["conf", "ini"],
    ["env", "dotenv"],
    ["xml", "xml"],
    ["json", "json"],
    ["jsonl", "jsonl"],
    ["cs", "csharp"],
    ["php", "php"],
    ["kt", "kotlin"],
    ["swift", "swift"],
    ["vue", "vue"],
    ["svelte", "svelte"],
    ["graphql", "graphql"],
    ["gql", "graphql"],
    ["proto", "proto"],
    ["tf", "hcl"],
    ["hcl", "hcl"],
    ["diff", "diff"],
    ["patch", "diff"],
    ["html", "html"],
    ["htm", "html"],
    ["svg", "xml"],
    ["mdx", "mdx"],
    ["log", "log"],
  ])("maps .%s to the %s grammar", (extension, language) => {
    expect(resolveAttachmentPresentation(`source.${extension}`, "application/octet-stream"))
      .toEqual(presentation("code", "code", language as AttachmentPresentation["shikiLanguage"]))
  })

  it("keeps plain text readable without a grammar", () => {
    expect(resolveAttachmentPresentation("notes.txt", "application/octet-stream"))
      .toEqual(presentation("text", "text"))
  })

  it("does not let a misleading filename override a specific MIME", () => {
    expect(resolveAttachmentPresentation("payload.html", "application/pdf"))
      .toEqual(presentation("pdf", null))
    expect(resolveAttachmentPresentation("payload.ts", "application/x-custom"))
      .toEqual(presentation("unknown", null))
  })
})

describe("formatAttachmentSize", () => {
  it("formats bytes with stable binary units", () => {
    expect(formatAttachmentSize(0)).toBe("0 B")
    expect(formatAttachmentSize(1536)).toBe("1.5 KB")
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe("2.0 MB")
  })
})
