import { describe, expect, it } from "vitest"
import { selectHtmlPreviews } from "./html-preview-markdown"
import { isHtmlPreviewFile, MAX_HTML_PREVIEW_BYTES } from "./html-preview-policy"
import type { FileAttachment } from "./models/message"

const file: FileAttachment = { id: "own-id", kind: "file", name: "page.html", contentType: "text/html", url: "/attachments/own-id", size: "1 KB" }
const marker = "[alook-html-preview](own-id)"
describe("HTML attachment selection", () => {
  it.each([marker, `before ${marker} after`, `before\n\n${marker}\n\nafter`, `> ${marker}`, `- ${marker}`])("selects one own HTML marker: %s", (text) => {
    expect([...selectHtmlPreviews(text, [file]).keys()]).toEqual(["own-id"])
  })
  it("deduplicates within a message and permits another message's own reuse", () => {
    expect(selectHtmlPreviews(`${marker}\n\n${marker}`, [file]).size).toBe(1)
    expect(selectHtmlPreviews(marker, [file]).size).toBe(1)
  })
  it.each([
    `\`${marker}\``, `\`\`\`html\n${marker}\n\`\`\``, `\\${marker}`, `prefix${marker}`, `${marker}suffix`,
    "[**alook-html-preview**](own-id)", "[alook-html-preview](https://example.com)",
    "[alook-html-preview](<own-id>)", "[alook-html-preview](own-id \"title\")",
    "[alook-html-preview][ref]\n\n[ref]: own-id", `||${marker}||`, `**${marker}**`,
  ])("keeps code, escaped, nested and nonliteral markers inert: %s", (text) => {
    expect(selectHtmlPreviews(text, [file]).size).toBe(0)
  })
  it("requires this message's canonical ID, applicable type and size", () => {
    for (const attachments of [[], [{ ...file, id: undefined }], [{ ...file, id: "foreign" }], [{ ...file, name: "file.txt", contentType: "text/plain" }], [{ ...file, sizeBytes: MAX_HTML_PREVIEW_BYTES + 1 }]]) {
      expect(selectHtmlPreviews(marker, attachments).size).toBe(0)
    }
  })
  it.each([["x.html", null, true], ["x.htm", "application/octet-stream", true], ["x", "text/html; charset=utf-8", true], ["x.html", "image/png", false], ["x.xhtml", "application/xhtml+xml", false]])("classifies HTML without accepting conflicting types", (name, type, expected) => {
    expect(isHtmlPreviewFile(name as string, type as string | null)).toBe(expected)
  })
})
