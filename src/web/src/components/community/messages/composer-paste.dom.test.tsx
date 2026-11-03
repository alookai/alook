import { EditorContent } from "@tiptap/react"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { useComposerController } from "./use-composer-controller"

describe("Compose native editor paste admission", () => {
  it("consumes file clipboard data before generic parsing and still parses ordinary HTML", async () => {
    let current!: ReturnType<typeof useComposerController>
    function Capture() {
      current = useComposerController({ channel: "general", context: "channel", members: [], hideEmoji: true, sendContract: "accepted", onAcceptSend: () => false }, null)
      return <EditorContent editor={current.editor} />
    }
    const view = renderCommunity(<Capture />)
    await waitFor(() => expect(current.editor?.view.dom).toBeDefined())
    const editor = current.editor!
    const parseHtml = vi.fn((html: string) => html)
    editor.setOptions({ editorProps: { ...editor.options.editorProps, transformPastedHTML: parseHtml } })
    const file = new File(["document"], "clipboard.txt", { type: "text/plain" })
    const readClipboard = vi.fn(() => { throw new Error("File paste must not read/parse text or HTML") })
    await act(async () => {
      fireEvent.paste(editor.view.dom, { clipboardData: { items: [{ kind: "file", getAsFile: () => file }], getData: readClipboard } })
    })
    await waitFor(() => expect(current.pendingFiles.map(item => item.file)).toEqual([file]))
    expect(readClipboard).not.toHaveBeenCalled()
    expect(parseHtml).not.toHaveBeenCalled()
    expect(editor.isEmpty).toBe(true)

    editor.setOptions({ editorProps: { ...editor.options.editorProps, transformPastedHTML: parseHtml } })
    await act(async () => {
      fireEvent.paste(editor.view.dom, { clipboardData: { items: [], getData: (type: string) => type === "text/html" ? "<p><strong>Ordinary HTML</strong></p>" : "Ordinary HTML" } })
    })
    expect(parseHtml).toHaveBeenCalledOnce()
    expect(editor.getText()).toBe("Ordinary HTML")
    expect(editor.getHTML()).toBe("<p>Ordinary HTML</p>")
    view.unmount()
  })
})
