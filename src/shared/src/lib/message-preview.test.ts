import { describe, expect, it } from "vitest"
import { MESSAGE_PREVIEW_LENGTH } from "../constants/community"
import { messagePreview, messagePreviewText } from "./message-preview"

describe("semantic message previews", () => {
  it("projects complete chat syntax and preserves literal code and filenames", () => {
    expect(messagePreviewText({ content: "**Hello** [read me](https://example.test/a_(b)) `file_name.ts`\n\n> second\n\n- third" }))
      .toBe("Hello read me file_name.ts second third")
    expect(messagePreviewText({ content: "界**界** /team#0042/design#7" })).toBe("界界 /team#0042/design#7")
    expect(messagePreviewText({ content: "界**界**，~~界~~。 @user#0042 https://example.test。Next" }))
      .toBe("界界，界。 @user#0042 https://example.test。Next")
  })

  it("masks spoilers and the existing redaction syntax without exposing hidden text", () => {
    const text = messagePreviewText({ content: "before ||**private** [secret](https://hidden.test)|| after [REDACTED_EMAIL] `a_[REDACTED_TOKEN]`" })
    expect(text).toBe("before [Spoiler] after [redacted] a_[redacted]")
    for (const hidden of ["private", "secret", "hidden.test", "REDACTED_EMAIL", "REDACTED_TOKEN"]) expect(text).not.toContain(hidden)
  })

  it("keeps block boundaries and supplies readable non-rendering labels", () => {
    expect(messagePreviewText({ content: "```ts\nconst file_name = 1\n```\n\n| Name | Value |\n| --- | --- |\n| a | b |\n\n$$x + y$$\n\n```mermaid\ngraph LR; A-->B\n```\n\n![a photo](https://example.test/a.png)" }))
      .toBe("Code: const file_name = 1 Name Value a b Math: x + y Diagram Photo: a photo")
  })

  it("retains typed HTML as literal safe text, as the body does", () => {
    expect(messagePreviewText({ content: "<b>literal</b> and x < y" })).toBe("<b>literal</b> and x < y")
  })

  it("uses exact HTML marker binding and includes attachment-only messages", () => {
    const html = { id: "html1", name: "page.html", contentType: "text/html", sizeBytes: 50 }
    expect(messagePreviewText({ content: "[alook-html-preview](html1)", attachments: [html] })).toBe("HTML preview")
    expect(messagePreviewText({ content: "[alook-html-preview](html1)\n\n[alook-html-preview](html1)", attachments: [html] })).toBe("HTML preview")
    for (const content of ["[alook-html-preview](missing)", "[alook-html-preview](html1 \"title\")", "x[alook-html-preview](html1)"]) {
      expect(messagePreviewText({ content, attachments: [html] })).toContain("alook-html-preview")
    }
    expect(messagePreviewText({ content: "[alook-html-preview](html1)", attachments: [{ ...html, sizeBytes: 2 * 1024 * 1024 + 1 }] })).toContain("alook-html-preview")
    expect(messagePreviewText({ attachments: [{ name: "photo_one.png", contentType: "image/png" }, { name: "clip.mp4", contentType: "video/mp4" }, { name: "voice.wav", contentType: "audio/wav" }, { name: "file_name.zip" }] }))
      .toBe("Photo: photo_one.png Video: clip.mp4 Audio: voice.wav Attachment: file_name.zip")
  })

  it("summarizes structured cards from their canonical metadata", () => {
    expect(messagePreviewText({ content: '{"internal":"data"}', approval: { friendshipId: "f1" } })).toBe("Friend request")
    expect(messagePreviewText({ botCreation: { requestId: "b1" } })).toBe("Bot creation request")
    expect(messagePreviewText({ type: "system", systemKind: "thread" })).toBe("Thread created")
  })

  it("parses the entire message before the existing UTF-16 truncation", () => {
    const label = "x".repeat(MESSAGE_PREVIEW_LENGTH + 20)
    expect(messagePreview({ content: `[${label}](https://example.test)` })).toBe(`${"x".repeat(MESSAGE_PREVIEW_LENGTH - 1)}…`)
    expect(messagePreview({ content: `||${"hidden".repeat(100)}|| visible` })).toBe("[Spoiler] visible")
  })
})
