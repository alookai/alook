import { Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EditorView } from "@tiptap/pm/view"
import { normalizeConsecutiveTerminalHardBreak } from "./consecutive-hard-break"

const editors: Editor[] = []

function createEditor(content: Parameters<typeof Editor>[0]["content"]): Editor {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        codeBlock: false,
        code: false,
        blockquote: false,
        bold: false,
        italic: false,
        strike: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
      }),
    ],
    content,
  })
  editors.push(editor)
  return editor
}

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter",
    shiftKey: true,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

function viewFor(editor: Editor): EditorView {
  return {
    state: editor.state,
    dispatch: (transaction) => editor.view.updateState(editor.state.apply(transaction)),
  } as EditorView
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe("consecutive terminal hard breaks", () => {
  it("normalizes the second soft break into a paragraph boundary without changing plaintext", () => {
    const editor = createEditor({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "2." },
          { type: "hardBreak" },
        ],
      }],
    })
    editor.commands.setTextSelection(editor.state.doc.content.size)
    const before = `${editor.getText({ blockSeparator: "\n\n" })}\n`
    const event = keyEvent()

    expect(normalizeConsecutiveTerminalHardBreak(viewFor(editor), event)).toBe(true)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(editor.getJSON()).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "2." }] },
        { type: "paragraph" },
      ],
    })
    expect(editor.getText({ blockSeparator: "\n\n" })).toBe(before)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph")
    expect(editor.state.selection.$from.parentOffset).toBe(0)
  })

  it("leaves the first soft break and non-terminal selections to TipTap", () => {
    const editor = createEditor({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "line" }],
      }],
    })
    editor.commands.setTextSelection(editor.state.doc.content.size)
    const event = keyEvent()

    expect(normalizeConsecutiveTerminalHardBreak(viewFor(editor), event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(editor.getText()).toBe("line")
  })

  it("preserves every newline across a longer run without consecutive hard breaks", () => {
    const editor = createEditor({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "2." }],
      }],
    })
    editor.commands.setTextSelection(editor.state.doc.content.size)

    for (let newlineCount = 1; newlineCount <= 4; newlineCount += 1) {
      const event = keyEvent()
      if (!normalizeConsecutiveTerminalHardBreak(viewFor(editor), event)) {
        expect(editor.commands.setHardBreak()).toBe(true)
      }
      expect(editor.getText({ blockSeparator: "\n\n" })).toBe(
        `2.${"\n".repeat(newlineCount)}`,
      )
    }

    const json = JSON.stringify(editor.getJSON())
    expect(json).not.toContain('"type":"hardBreak"},{"type":"hardBreak"')
    expect(editor.state.selection.empty).toBe(true)
  })

  it.each([
    { key: "Escape" },
    { shiftKey: false },
    { isComposing: true },
  ])("ignores non-soft-break key paths: %o", (overrides) => {
    const editor = createEditor({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "hardBreak" }],
      }],
    })
    editor.commands.setTextSelection(editor.state.doc.content.size)
    const event = keyEvent(overrides)

    expect(normalizeConsecutiveTerminalHardBreak(viewFor(editor), event)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
