import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Editor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { describe, expect, it } from "vitest"
import { render, act } from "@/test/react-dom-harness"
import { ComposerView, type ComposerViewProps } from "./composer-view"
import { EMPTY_MENTION_STATE } from "@/lib/community/mention-extension"
import { EMPTY_CHANNEL_REF_STATE } from "@/lib/community/channel-ref-extension"

function props(editor: Editor | null): ComposerViewProps {
  return {
    editor, isForumThreadBody: false, dragging: false, pendingFiles: [],
    onDragEnter: () => {}, onDragLeave: () => {}, onDragOver: () => {}, onDrop: () => {},
    mentionPopup: EMPTY_MENTION_STATE, mentionPresentation: { status: "ready" },
    channelRefPopup: EMPTY_CHANNEL_REF_STATE, removePendingFile: () => {},
    fileInputRef: { current: null }, onFileSelect: () => {},
    hideAttach: true, hideEmoji: true, showSend: false, sendDisabled: true,
    onSend: () => {}, onUploadFile: () => {}, onEmojiPick: () => {},
  }
}

describe("native editor first-line footprint", () => {
  it("keeps the composer host in SSR before Tiptap creates its first paragraph", () => {
    const markup = renderToStaticMarkup(createElement(ComposerView, props(null)))
    expect(markup).toContain("min-h-6")
    expect(markup).toContain("chat-input-line-height")
    expect(markup).not.toContain("contenteditable")
  })

  it("keeps one minimum line through actual EditorContent attachment without capping multiple lines", async () => {
    const view = render(createElement(ComposerView, props(null)))
    const before = view.container.querySelector(".chat-input-line-height")!
    expect(before).toHaveClass("min-h-6")
    expect(before.querySelector("[contenteditable]")).toBeNull()
    const editor = new Editor({ extensions: [StarterKit], content: "<p></p>" })
    try {
      await act(async () => { view.rerender(createElement(ComposerView, props(editor))) })
      const host = view.container.querySelector(".chat-input-line-height")!
      expect(host).toHaveClass("min-h-6", "max-h-48")
      expect(host.querySelector("[contenteditable] p")).not.toBeNull()
      await act(async () => { editor.commands.setContent("<p>First</p><p>Second</p>") })
      expect(host.querySelectorAll("[contenteditable] p")).toHaveLength(2)
      expect(host).not.toHaveClass("h-6")
    } finally {
      view.unmount()
      editor.destroy()
    }
  })

  it("uses the installed native null-editor wrapper contract", () => {
    const markup = renderToStaticMarkup(createElement(EditorContent, { editor: null, className: "native-host" }))
    expect(markup).toContain('<div class="native-host">')
  })
})
