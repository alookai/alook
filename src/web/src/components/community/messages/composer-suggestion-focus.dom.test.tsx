import { createRef, useLayoutEffect } from "react"
import { EditorContent, type Editor } from "@tiptap/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, screen, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { readComposerDraft, writeComposerDraft } from "@/lib/community/composer-draft"
import type { Member } from "@/lib/community/models/people"
import { CommunityMentionList, ChannelRefList } from "./composer-suggestion-popups"
import type { ComposerHandle, ComposerProps } from "./composer-types"
import { useComposerController } from "./use-composer-controller"

const files = vi.hoisted(() => ({
  pendingFiles: [], readPendingFiles: () => [], setPendingFiles: vi.fn(),
  transferPendingFiles: vi.fn(), awaitPendingFiles: async () => [], addPendingFiles: vi.fn(),
  fileInputRef: { current: null }, handleFileSelect: vi.fn(), removePendingFile: vi.fn(),
  dragging: false, handleDragEnter: vi.fn(), handleDragLeave: vi.fn(),
  handleDragOver: vi.fn(), handleDrop: vi.fn(),
}))
vi.mock("@/hooks/use-file-attachments", () => ({ useFileAttachments: () => files }))
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))

type View = ReturnType<typeof useComposerController>
type Probe = { current: View | null }
const ada: Member = { id: "member-ada", userId: "user-ada", name: "Ada", discriminator: "0001", avatar: "A", avatarVersion: 0, status: "online", sub: "", role: "member" }
const general = { id: "channel-general", name: "general", serverId: "server-one", serverName: "One", serverDiscriminator: "0001" }
const props: ComposerProps = {
  channel: "general", context: "channel", members: [ada], channelRefCandidates: [general],
  sendContract: "accepted", onAcceptSend: () => true, hideAttach: true, hideEmoji: true,
}

function Harness({ probeRef, handle, ...options }: ComposerProps & { probeRef: Probe; handle?: React.Ref<ComposerHandle> }) {
  const view = useComposerController(options, handle ?? null)
  useLayoutEffect(() => { probeRef.current = view }, [probeRef, view])
  return <>
    <EditorContent editor={view.editor} />
    <CommunityMentionList state={view.mentionPopup} presentation={view.mentionPresentation} />
    <ChannelRefList state={view.channelRefPopup} presentation={view.channelRefPresentation} />
  </>
}

async function editorOf(probeRef: Probe): Promise<Editor> {
  await waitFor(() => expect(probeRef.current?.editor).toBeTruthy())
  return probeRef.current!.editor!
}

async function type(editor: Editor, value: string) {
  await act(async () => {
    editor.view.dom.focus()
    editor.commands.insertContent(value)
  })
}

describe("composer suggestion focus with installed TipTap", () => {
  beforeEach(() => {
    localStorage.clear()
    const rect = new DOMRect(10, 20, 1, 18)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect })
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [rect] })
  })
  afterEach(() => {
    delete (Range.prototype as Partial<Range>).getBoundingClientRect
    delete (Range.prototype as Partial<Range>).getClientRects
  })

  it.each(["@", "@a", "/"])("restores %s without opening; focus alone stays quiet and an edit opens", async (trigger) => {
    const probeRef: Probe = { current: null }
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: trigger }] }] }
    writeComposerDraft("viewer:focus-draft", draft)
    render(<Harness {...props} probeRef={probeRef} draftKey="focus-draft" autoFocus />)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    expect(editor.getText()).toBe(trigger)
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(probeRef.current!.channelRefPopup.command).toBeNull()
    expect(screen.queryByTestId("community-mention-popup")).toBeNull()
    expect(screen.queryByTestId("community-channel-ref-popup")).toBeNull()
    expect(readComposerDraft("viewer:focus-draft")).toEqual(draft)
    const suffix = trigger.startsWith("@") ? trigger === "@" ? "a" : "d" : "g"
    await type(editor, suffix)
    await waitFor(() => expect(trigger.startsWith("@") ? probeRef.current!.mentionPopup.command : probeRef.current!.channelRefPopup.command).toBeTypeOf("function"))
    expect(editor.getText()).toBe(`${trigger}${suffix}`)
  })

  it.each(["@", "/"])("keeps the active %s candidate and caret when automatic focus turns on", async (trigger) => {
    const probeRef: Probe = { current: null }
    const options = { ...props, probeRef, draftKey: "autofocus-boundary" }
    const renderer = render(<Harness {...options} autoFocus={false} />)
    const editor = await editorOf(probeRef)
    await type(editor, trigger === "@" ? "@a" : "/g")
    const rowId = trigger === "@" ? "community-mention-option-member-ada" : "community-channel-ref-option-channel-general"
    await screen.findByTestId(rowId)
    const selection = editor.state.selection.toJSON()
    const draft = editor.getJSON()

    for (const autoFocus of [true, false, true]) {
      await act(async () => { renderer.rerender(<Harness {...options} autoFocus={autoFocus} />) })
      expect(document.activeElement).toBe(editor.view.dom)
      expect(editor.isFocused).toBe(true)
      expect(editor.state.selection.toJSON()).toEqual(selection)
      expect(editor.getJSON()).toEqual(draft)
      expect(readComposerDraft("viewer:autofocus-boundary")).toEqual(draft)
      expect(screen.getByTestId(rowId)).toBeVisible()
    }

    await act(async () => { fireEvent.mouseDown(screen.getByTestId(rowId)) })
    const nodeType = trigger === "@" ? "mention" : "channelRef"
    expect(editor.getJSON().content?.[0].content?.filter((node) => node.type === nodeType)).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ id: trigger === "@" ? ada.id : general.id }) }),
    ])
    expect(screen.queryByTestId(rowId)).toBeNull()
    expect(readComposerDraft("viewer:autofocus-boundary")).toEqual(editor.getJSON())
  })

  it.each(["@", "/"])("moves focus between composers with only one %s popup and inert old insertion", async (trigger) => {
    const parent: Probe = { current: null }, thread: Probe = { current: null }
    render(<><Harness {...props} probeRef={parent} draftKey="parent" /><Harness {...props} context="thread" channel="thread" probeRef={thread} draftKey="thread" /></>)
    const first = await editorOf(parent), second = await editorOf(thread)
    await type(first, trigger)
    await waitFor(() => expect(trigger === "@" ? parent.current!.mentionPopup.command : parent.current!.channelRefPopup.command).toBeTypeOf("function"))
    const stale = trigger === "@" ? parent.current!.mentionPopup.command! : parent.current!.channelRefPopup.command!
    await type(second, trigger)
    await waitFor(() => expect(trigger === "@" ? thread.current!.mentionPopup.command : thread.current!.channelRefPopup.command).toBeTypeOf("function"))
    expect(parent.current!.mentionPopup.command).toBeNull()
    expect(parent.current!.channelRefPopup.command).toBeNull()
    expect(screen.getAllByTestId(trigger === "@" ? "community-mention-popup" : "community-channel-ref-popup")).toHaveLength(1)
    await act(async () => { stale({ id: "stale", label: "stale", serverId: "server-one", serverName: "One", serverDiscriminator: "0001" }) })
    expect(first.getText()).toBe(trigger)
    expect(second.getText()).toBe(trigger)
    expect(readComposerDraft("viewer:parent")).toEqual(first.getJSON())
  })

  it("preserves focus on candidate mousedown and inserts one canonical mention", async () => {
    const probeRef: Probe = { current: null }
    render(<Harness {...props} probeRef={probeRef} draftKey="clicked" />)
    const editor = await editorOf(probeRef)
    await type(editor, "@a")
    const row = await screen.findByTestId("community-mention-option-member-ada")
    await act(async () => { fireEvent.mouseDown(row) })
    expect(editor.isFocused).toBe(true)
    expect(editor.getJSON().content?.[0].content?.filter((node) => node.type === "mention")).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ id: ada.id, label: "Ada#0001" }) }),
    ])
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(readComposerDraft("viewer:clicked")).toEqual(editor.getJSON())
  })

  it.each(["Enter", "Tab"])("keeps IME confirmation inert, then %s inserts once", async (key) => {
    const probeRef: Probe = { current: null }
    render(<Harness {...props} probeRef={probeRef} />)
    const editor = await editorOf(probeRef)
    await type(editor, "@a")
    await screen.findByTestId("community-mention-option-member-ada")
    await act(async () => {
      fireEvent.compositionStart(editor.view.dom)
      fireEvent.keyDown(editor.view.dom, { key, isComposing: true })
    })
    expect(editor.getText()).toBe("@a")
    expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function")
    await act(async () => { fireEvent.compositionEnd(editor.view.dom) })
    await waitFor(() => expect(editor.view.composing).toBe(false))
    expect(probeRef.current!.mentionPopup.items.map((item) => item.id)).toEqual([ada.id])
    await act(async () => { fireEvent.keyDown(editor.view.dom, { key }) })
    expect(editor.getText()).toBe("@a")
    expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function")
    await act(async () => { fireEvent.keyDown(editor.view.dom, { key }) })
    expect(editor.getJSON().content?.[0].content?.filter((node) => node.type === "mention")).toHaveLength(1)
    expect(probeRef.current!.mentionPopup.command).toBeNull()
  })

  it.each(["@", "/"])("Escape closes empty/loading %s and canonical data cannot reopen it", async (trigger) => {
    const probeRef: Probe = { current: null }
    const search = vi.fn(), intent = vi.fn()
    const loading = { loading: true, failed: false }
    const renderer = render(<Harness {...props} probeRef={probeRef} members={[]} channelRefCandidates={[]} mentionCandidates={{ ...loading, search, searchQuery: "missing", searchStatus: "loading" }} channelRefCandidateSource={loading} onChannelRefIntent={intent} />)
    const editor = await editorOf(probeRef)
    await type(editor, `${trigger}missing`)
    await waitFor(() => expect(trigger === "@" ? probeRef.current!.mentionPopup.command : probeRef.current!.channelRefPopup.command).toBeTypeOf("function"))
    await act(async () => { fireEvent.keyDown(editor.view.dom, { key: "Escape" }) })
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(probeRef.current!.channelRefPopup.command).toBeNull()
    await act(async () => { renderer.rerender(<Harness {...props} probeRef={probeRef} members={[{ ...ada, name: "missing" }]} channelRefCandidates={[{ ...general, name: "missing" }]} mentionCandidates={{ loading: false, failed: false, search, searchQuery: "missing", searchStatus: "ready" }} channelRefCandidateSource={{ loading: false, failed: false }} onChannelRefIntent={intent} />) })
    await act(async () => { editor.view.dispatch(editor.state.tr) })
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(probeRef.current!.channelRefPopup.command).toBeNull()
    expect(editor.getText()).toBe(`${trigger}missing`)
  })

  it("ends old scope before rebinding search, preserves draft and allows a new DM slash", async () => {
    const probeRef: Probe = { current: null }
    const oldSearch = vi.fn(), nextSearch = vi.fn()
    const renderer = render(<Harness {...props} probeRef={probeRef} draftKey="channel" mentionCandidates={{ loading: false, failed: false, search: oldSearch }} />)
    const editor = await editorOf(probeRef)
    await type(editor, "@")
    await waitFor(() => expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function"))
    const stale = probeRef.current!.mentionPopup.command!
    oldSearch.mockClear()
    await act(async () => { renderer.rerender(<Harness {...props} probeRef={probeRef} context="dm" channel="Ada" draftKey="dm" mentionCandidates={{ loading: false, failed: false, search: nextSearch }} />) })
    expect(oldSearch).toHaveBeenCalledExactlyOnceWith("")
    expect(nextSearch).not.toHaveBeenCalled()
    await act(async () => { stale({ id: ada.id, label: "Ada#0001" }); editor.commands.clearContent(); editor.commands.insertContent("/") })
    await waitFor(() => expect(probeRef.current!.channelRefPopup.command).toBeTypeOf("function"))
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(editor.getText()).toBe("/")
  })

  it.each(["@", "/"])("a new scope restores %s quietly, then accepts its current edit", async (trigger) => {
    const probeRef: Probe = { current: null }
    writeComposerDraft("viewer:next", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: trigger }] }] })
    const renderer = render(<Harness {...props} probeRef={probeRef} draftKey="previous" />)
    const editor = await editorOf(probeRef)
    await type(editor, trigger)
    await waitFor(() => expect(trigger === "@" ? probeRef.current!.mentionPopup.command : probeRef.current!.channelRefPopup.command).toBeTypeOf("function"))
    await act(async () => { renderer.rerender(<Harness {...props} probeRef={probeRef} channel="next" draftKey="next" autoFocus />) })
    expect(editor.getText()).toBe(trigger)
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(probeRef.current!.channelRefPopup.command).toBeNull()
    await type(editor, trigger === "@" ? "a" : "g")
    await waitFor(() => expect(trigger === "@" ? probeRef.current!.mentionPopup.command : probeRef.current!.channelRefPopup.command).toBeTypeOf("function"))
    expect(readComposerDraft("viewer:next")).toEqual(editor.getJSON())
  })

  it("clear then one @ stays one @ and persists current JSON", async () => {
    const probeRef: Probe = { current: null }, handle = createRef<ComposerHandle>()
    writeComposerDraft("viewer:clear", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@" }] }] })
    render(<Harness {...props} probeRef={probeRef} handle={handle} draftKey="clear" />)
    const editor = await editorOf(probeRef)
    await act(async () => { handle.current!.focusEditor() })
    await waitFor(() => expect(editor.isFocused).toBe(true))
    await act(async () => { editor.commands.clearContent() })
    expect(editor.isEmpty).toBe(true)
    expect(readComposerDraft("viewer:clear")).toBeNull()
    await type(editor, "@")
    await waitFor(() => expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function"))
    expect(editor.getText()).toBe("@")
    expect(readComposerDraft("viewer:clear")).toEqual(editor.getJSON())
  })

  it("destroy clears the visible suggestion without dispatch to the dying view", async () => {
    const probeRef: Probe = { current: null }
    const renderer = render(<Harness {...props} probeRef={probeRef} />)
    const editor = await editorOf(probeRef)
    await type(editor, "@")
    await waitFor(() => expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function"))
    const dispatch = vi.spyOn(editor.view, "dispatch")
    await act(async () => { editor.destroy() })
    expect(dispatch).not.toHaveBeenCalled()
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(probeRef.current!.channelRefPopup.command).toBeNull()
    renderer.unmount()
  })
})
