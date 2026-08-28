import { describe, expect, it } from "vitest"
import { Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { textNodeForCaretInsertion } from "./caret-text-insertion"

function insertAtCaret(content: string, caret: number, token: string): string {
  const editor = new Editor({
    element: null,
    extensions: [StarterKit],
    content: {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: content }],
      }],
    },
  })
  editor.commands.setTextSelection(caret + 1)
  editor.commands.insertContent(textNodeForCaretInsertion(token, editor.state))
  const result = editor.getText()
  editor.destroy()
  return result
}

describe("caret text insertion through TipTap", () => {
  it("round-trips an HTML-shaped legal community name as literal text", () => {
    expect(insertAtCaret("helloworld", 5, "@<b>Alice</b>#0042"))
      .toBe("hello @<b>Alice</b>#0042 world")
  })

  it("round-trips an ampersand in a legal community name as literal text", () => {
    expect(insertAtCaret("saynow", 3, "@A&B#0043"))
      .toBe("say @A&B#0043 now")
  })
})
