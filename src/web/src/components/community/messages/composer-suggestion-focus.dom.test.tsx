import { createRef, useLayoutEffect, type ComponentProps, type ReactNode } from "react"
import { EditorContent, type Editor } from "@tiptap/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { USE_SERVER_DEFAULT } from "@alook/shared"
import { act, fireEvent, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { readComposerDraft, writeComposerDraft } from "@/lib/community/composer-draft"
import type { Member } from "@/lib/community/models/people"
import { CommunityMentionList, ChannelRefList } from "./composer-suggestion-popups"
import type { ComposerHandle, ComposerProps } from "./composer-types"
import { useComposerController } from "./use-composer-controller"
import { TextChannelSurface } from "../channels/text-channel-surface"
import { NATIVE_MOBILE_BACK_EVENT, useNativeMobileBack } from "@/hooks/community/use-native-mobile-back"
import type { MessageChannelControllerValue } from "./message-channel-controller"

const files = vi.hoisted(() => ({
  pendingFiles: [], readPendingFiles: () => [], setPendingFiles: vi.fn(),
  transferPendingFiles: vi.fn(), awaitPendingFiles: async () => [], addPendingFiles: vi.fn(),
  fileInputRef: { current: null }, handleFileSelect: vi.fn(), removePendingFile: vi.fn(),
  dragging: false, handleDragEnter: vi.fn(), handleDragLeave: vi.fn(),
  handleDragOver: vi.fn(), handleDrop: vi.fn(),
}))
vi.mock("@/hooks/use-file-attachments", () => ({ useFileAttachments: () => files }))
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))

const surfaces = vi.hoisted(() => ({
  breakpoint: "desktop" as "unknown" | "mobile" | "desktop",
  probes: new Map<string, { current: ReturnType<typeof useComposerController> | null }>(),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => surfaces.breakpoint }))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: () => ({ messages: [], isLoading: false, readSnapshotFetching: false, anchorInCache: true }),
}))
vi.mock("@/components/community/channels/channel-header", () => ({ ChannelHeader: () => null }))
vi.mock("@/components/community/channels/channel-shell", () => ({ ChannelShell: ({ body }: { body: ReactNode }) => body }))
vi.mock("@/components/community/shell/community-panel", () => ({ CommunityPanel: () => null }))
vi.mock("@/components/community/messages/message-list", () => ({ MessageList: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/messages/composer", async () => {
  const { forwardRef } = await import("react")
  return {
    Composer: forwardRef<ComposerHandle, ComposerProps>((options, handle) => {
      const key = options.draftKey!
      if (!surfaces.probes.has(key)) surfaces.probes.set(key, { current: null })
      return <Harness {...options} handle={handle} probeRef={surfaces.probes.get(key)!} />
    }),
  }
})
vi.mock("@/components/community/messages/message-channel-controller", () => ({
  MessageChannelController: ({ children }: { children: (value: MessageChannelControllerValue) => ReactNode }) => children({
    feed: {} as MessageChannelControllerValue["feed"],
    pinnedIds: new Set(), replyTo: null, setReplyTo: vi.fn(),
    searchQuery: "", searchResults: [], searchLoading: false, search: vi.fn(),
    scrollTargetId: null, setScrollTargetId: vi.fn(), consumeScrollTarget: vi.fn(),
    contextTarget: null, setContextTarget: vi.fn(), openContextSeq: vi.fn(),
    onSheetReply: vi.fn(), jumpToSeq: vi.fn(),
    messageActions: {} as MessageChannelControllerValue["messageActions"],
    threadActions: {} as MessageChannelControllerValue["threadActions"],
    localSubmitVersion: 0,
    acceptMessage: vi.fn(() => true), handleTyping: vi.fn(), typingUsers: [],
  }),
}))

type View = ReturnType<typeof useComposerController>
type Probe = { current: View | null }
const ada: Member = { id: "member-ada", userId: "user-ada", name: "Ada", discriminator: "0001", avatar: "A", avatarVersion: 0, status: "online", sub: "", role: "member" }
const general = { id: "channel-general", name: "general", serverId: "server-one", serverName: "One", serverDiscriminator: "0001" }
const props: ComposerProps = {
  channel: "general", context: "channel", members: [ada], channelRefCandidates: [general],
  sendContract: "accepted", onAcceptSend: () => true, hideAttach: true, hideEmoji: true,
}
const textSurfaceProps: ComponentProps<typeof TextChannelSurface> = {
  channelId: "parent", serverId: "server-one", serverParam: "server-one", channelName: "parent",
  viewer: { id: "viewer", name: "Viewer", avatar: "V" }, canManagePins: false, anchorMessageId: null,
  notificationLevel: USE_SERVER_DEFAULT, onSetNotificationLevel: vi.fn(),
  composerMembers: [ada], composerMentionCandidates: undefined, channelRefCandidates: [general],
  memberPanelProps: { members: [], membersLoading: false, membersLoadingMore: false, membersHasMore: false },
  manageMembersDialog: null, uiHandlers: {}, onOpenThread: vi.fn(), onOpenProfile: vi.fn(), resolveUserName: (id) => id,
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

function dispatchDeletion(editor: Editor, key: "Delete" | "Backspace", options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key, code: key, keyCode: key === "Delete" ? 46 : 8,
    bubbles: true, cancelable: true, ...options,
  })
  editor.view.dom.dispatchEvent(event)
  return event
}

function BackListener({ replacePath }: { replacePath: (path: string) => void }) {
  useNativeMobileBack({ dismissShellOverlay: () => false, parentPath: "/c/me", replacePath })
  return null
}

describe("composer suggestion focus with installed TipTap", () => {
  beforeEach(() => {
    localStorage.clear()
    surfaces.breakpoint = "desktop"
    surfaces.probes.clear()
    const rect = new DOMRect(10, 20, 1, 18)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect })
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [rect] })
  })
  afterEach(() => {
    delete (Range.prototype as Partial<Range>).getBoundingClientRect
    delete (Range.prototype as Partial<Range>).getClientRects
    delete (document as Partial<Document>).elementFromPoint
    vi.restoreAllMocks()
  })

  it.each(["@", "/"])("native Back closes the active %s suggestion without leaving the draft", async (trigger) => {
    const probeRef: Probe = { current: null }
    const replacePath = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Harness {...props} probeRef={probeRef} draftKey="native-back" /></>)
    const editor = await editorOf(probeRef)
    await type(editor, trigger)
    await screen.findByTestId(trigger === "@" ? "community-mention-popup" : "community-channel-ref-popup")
    const draft = editor.getJSON()
    const event = new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })
    act(() => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(probeRef.current!.channelRefPopup.command).toBeNull()
    expect(editor.getJSON()).toEqual(draft)
    expect(readComposerDraft("viewer:native-back")).toEqual(draft)
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("replays a replaced mention source and lets native Back retire its aborted search", async () => {
    const probeRef: Probe = { current: null }
    const replacePath = vi.fn(), oldSearch = vi.fn()
    const nextSearch = vi.fn((query: string) => {
      if (!query) throw new DOMException("Retired source", "AbortError")
    })
    const listener = <BackListener replacePath={replacePath} />
    const renderer = render(<>{listener}<Harness {...props} probeRef={probeRef} draftKey="replaced-source" mentionCandidates={{ loading: false, failed: false, search: oldSearch, searchQuery: "ada", searchStatus: "ready" }} /></>)
    const editor = await editorOf(probeRef)
    await type(editor, "@ada")
    await screen.findByTestId("community-mention-popup")
    const draft = editor.getJSON()
    await act(async () => {
      renderer.rerender(<>{listener}<Harness {...props} probeRef={probeRef} draftKey="replaced-source" mentionCandidates={{ loading: false, failed: false, search: nextSearch, searchQuery: "", searchStatus: "idle" }} /></>)
    })
    await waitFor(() => expect(nextSearch).toHaveBeenCalledWith("ada"))
    expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function")
    const back = new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })
    act(() => { window.dispatchEvent(back) })
    expect(back.defaultPrevented).toBe(true)
    expect(nextSearch).toHaveBeenLastCalledWith("")
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(editor.view.hasFocus()).toBe(true)
    expect(editor.getJSON()).toEqual(draft)
    expect(readComposerDraft("viewer:replaced-source")).toEqual(draft)
    expect(replacePath).not.toHaveBeenCalled()
    await act(async () => {
      renderer.rerender(<>{listener}<Harness {...props} probeRef={probeRef} draftKey="replaced-source" mentionCandidates={{ loading: false, failed: false, search: nextSearch, searchQuery: "ada", searchStatus: "ready" }} /></>)
      editor.view.dispatch(editor.state.tr)
    })
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(editor.getJSON()).toEqual(draft)
    act(() => { window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })) })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
  })

  it("native Back remains with a composing editor", async () => {
    const probeRef: Probe = { current: null }
    const replacePath = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Harness {...props} probeRef={probeRef} /></>)
    const editor = await editorOf(probeRef)
    await type(editor, "test")
    act(() => { fireEvent.compositionStart(editor.view.dom) })
    const draft = editor.getJSON()
    act(() => { window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })) })
    expect(editor.getJSON()).toEqual(draft)
    expect(replacePath).not.toHaveBeenCalled()
    act(() => { fireEvent.compositionEnd(editor.view.dom) })
  })

  it("retires a destroyed editor owner and gives a rebuilt editor its own Back", async () => {
    const first: Probe = { current: null }, second: Probe = { current: null }
    const replacePath = vi.fn()
    const listener = <BackListener replacePath={replacePath} />
    const view = render(<>{listener}<Harness key="first" {...props} probeRef={first} draftKey="retiring-editor" /></>)
    const oldEditor = await editorOf(first)
    await type(oldEditor, "@a")
    await screen.findByTestId("community-mention-popup")
    view.rerender(<>{listener}<Harness key="second" {...props} probeRef={second} draftKey="rebuilt-editor" /></>)
    await waitFor(() => { expect(oldEditor.isDestroyed).toBe(true) })
    const editor = await editorOf(second)
    await type(editor, "/g")
    await screen.findByTestId("community-channel-ref-popup")
    act(() => { window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })) })
    expect(second.current!.channelRefPopup.command).toBeNull()
    expect(editor.getText()).toBe("/g")
    expect(replacePath).not.toHaveBeenCalled()
    act(() => { window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })) })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
  })

  it("keeps the current thread edit and candidate when an embedded parent mounts late, then accepts a parent click", async () => {
    const probeRef: Probe = { current: null }
    const thread = <Harness key="thread" {...props} context="thread" draftKey="late-thread" probeRef={probeRef} autoFocus />
    const renderer = render(<>{thread}</>)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    await type(editor, "@a")
    const candidateId = "community-mention-option-member-ada"
    await screen.findByTestId(candidateId)
    const input = editor.view.dom
    const selection = editor.state.selection.toJSON()
    const draft = editor.getJSON()
    const candidateCommand = probeRef.current!.mentionPopup.command

    for (const breakpoint of ["unknown", "desktop", "mobile", "desktop"] as const) {
      surfaces.breakpoint = breakpoint
      await act(async () => {
        renderer.rerender(<><TextChannelSurface key="parent" {...textSurfaceProps} embedded />{thread}</>)
      })
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(editor.view.dom).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(editor.isFocused).toBe(true)
      expect(editor.state.selection.toJSON()).toEqual(selection)
      expect(editor.getJSON()).toEqual(draft)
      expect(readComposerDraft("viewer:late-thread")).toEqual(draft)
      expect(probeRef.current!.mentionPopup.command).toBe(candidateCommand)
      expect(screen.getByTestId(candidateId)).toBeVisible()
    }

    const parent = await editorOf(surfaces.probes.get("server-one/parent")!)
    document.elementFromPoint = vi.fn(() => parent.view.dom)
    vi.spyOn(window, "scrollBy").mockImplementation(() => {})
    await act(async () => { await setupUser().click(parent.view.dom) })
    expect(document.activeElement).toBe(parent.view.dom)
    expect(parent.isFocused).toBe(true)
    await act(async () => { parent.commands.insertContent("parent input") })
    expect(parent.getText()).toBe("parent input")
    expect(readComposerDraft("viewer:server-one/parent")).toEqual(parent.getJSON())
    expect(editor.getJSON()).toEqual(draft)
    expect(readComposerDraft("viewer:late-thread")).toEqual(draft)
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(screen.queryByTestId(candidateId)).toBeNull()
  })

  it.each(["unknown", "mobile"] as const)("waits for desktop before focusing a full-page %s text conversation and accepts its input", async (breakpoint) => {
    surfaces.breakpoint = breakpoint
    const renderer = render(<TextChannelSurface {...textSurfaceProps} />)
    const editor = await editorOf(surfaces.probes.get("server-one/parent")!)
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(document.activeElement).not.toBe(editor.view.dom)
    expect(editor.isFocused).toBe(false)

    surfaces.breakpoint = "desktop"
    await act(async () => { renderer.rerender(<TextChannelSurface {...textSurfaceProps} />) })
    await waitFor(() => expect(document.activeElement).toBe(editor.view.dom))
    expect(surfaces.probes.get("server-one/parent")!.current!.editor).toBe(editor)
    expect(editor.isFocused).toBe(true)
    await act(async () => { editor.commands.insertContent("full-page input") })
    expect(editor.getText()).toBe("full-page input")
    expect(readComposerDraft("viewer:server-one/parent")).toEqual(editor.getJSON())
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
      expect.objectContaining({ attrs: expect.objectContaining({ id: trigger === "@" ? ada.userId : general.id }) }),
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
      expect.objectContaining({ attrs: expect.objectContaining({ id: ada.userId, label: "Ada#0001" }) }),
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

  it.each([false, true])("clears a restored @ with selectionchange first: %s", async (selectionChangeFirst) => {
    const probeRef: Probe = { current: null }
    const draftKey = `native-clear-${selectionChangeFirst}`
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@" }] }] }
    writeComposerDraft(`viewer:${draftKey}`, draft)
    render(<Harness {...props} probeRef={probeRef} draftKey={draftKey} autoFocus />)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    expect(editor.getJSON()).toEqual(draft)
    expect(probeRef.current!.mentionPopup.command).toBeNull()

    let observation: object = {}
    act(() => {
      const selection = document.getSelection()!
      const range = document.createRange()
      range.selectNodeContents(editor.view.dom)
      selection.removeAllRanges()
      selection.addRange(range)
      const before = {
        nativeText: selection.toString(), nativeCollapsed: selection.isCollapsed,
        modelSelection: editor.state.selection.toJSON(),
        document: editor.getJSON(), domText: editor.view.dom.textContent,
      }
      if (selectionChangeFirst) document.dispatchEvent(new Event("selectionchange"))
      const beforeKeySelection = editor.state.selection.toJSON()
      const deletion = new KeyboardEvent("keydown", {
        key: "Delete", code: "Delete", keyCode: 46, bubbles: true, cancelable: true,
      })
      editor.view.dom.dispatchEvent(deletion)
      observation = {
        selectionChangeFirst, before, beforeKeySelection,
        after: {
          modelSelection: editor.state.selection.toJSON(),
          document: editor.getJSON(), domText: editor.view.dom.textContent,
          isEmpty: editor.isEmpty, draft: readComposerDraft(`viewer:${draftKey}`),
          defaultPrevented: deletion.defaultPrevented,
        },
      }
    })
    expect(observation).toEqual({
      selectionChangeFirst,
      before: {
        nativeText: "@", nativeCollapsed: false,
        modelSelection: { type: "text", anchor: 2, head: 2 },
        document: draft, domText: "@",
      },
      beforeKeySelection: selectionChangeFirst
        ? { type: "text", anchor: 1, head: 2 }
        : { type: "text", anchor: 2, head: 2 },
      after: {
        modelSelection: { type: "text", anchor: 1, head: 1 },
        document: { type: "doc", content: [{ type: "paragraph" }] }, domText: "",
        isEmpty: true, draft: null, defaultPrevented: true,
      },
    })
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    await type(editor, "@")
    await waitFor(() => expect(probeRef.current!.mentionPopup.command).toBeTypeOf("function"))
    expect(editor.getText()).toBe("@")
    expect(readComposerDraft(`viewer:${draftKey}`)).toEqual(editor.getJSON())
  })

  it.each([
    ["Delete", false], ["Delete", true], ["Backspace", false], ["Backspace", true],
  ] as const)("deletes only the native partial range with %s, reversed: %s", async (key, reversed) => {
    const probeRef: Probe = { current: null }
    render(<Harness {...props} probeRef={probeRef} draftKey="native-partial" />)
    const editor = await editorOf(probeRef)
    await type(editor, "left@right")
    let result: object = {}
    act(() => {
      const text = editor.view.dom.querySelector("p")!.firstChild!
      const selection = document.getSelection()!
      selection.setBaseAndExtent(text, reversed ? 5 : 4, text, reversed ? 4 : 5)
      const before = {
        nativeText: selection.toString(), modelSelection: editor.state.selection.toJSON(),
      }
      const deletion = dispatchDeletion(editor, key)
      result = {
        before, text: editor.getText(), domText: editor.view.dom.textContent,
        modelSelection: editor.state.selection.toJSON(),
        draft: readComposerDraft("viewer:native-partial"), defaultPrevented: deletion.defaultPrevented,
      }
    })
    expect(result).toEqual({
      before: { nativeText: "@", modelSelection: { type: "text", anchor: 11, head: 11 } },
      text: "leftright", domText: "leftright", modelSelection: { type: "text", anchor: 5, head: 5 },
      draft: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "leftright" }] }] },
      defaultPrevented: true,
    })
  })

  it.each(["Delete", "Backspace"] as const)("keeps collapsed %s on the existing native path", async (key) => {
    const probeRef: Probe = { current: null }
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@" }] }] }
    writeComposerDraft("viewer:native-caret", draft)
    render(<Harness {...props} probeRef={probeRef} draftKey="native-caret" autoFocus />)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    let result: object = {}
    act(() => {
      const native = document.getSelection()!
      const text = editor.view.dom.querySelector("p")!.firstChild!
      native.collapse(text, 1)
      const deletion = dispatchDeletion(editor, key)
      result = {
        nativeCollapsed: native.isCollapsed, modelSelection: editor.state.selection.toJSON(),
        document: editor.getJSON(), draft: readComposerDraft("viewer:native-caret"),
        defaultPrevented: deletion.defaultPrevented,
      }
    })
    expect(result).toEqual({
      nativeCollapsed: true, modelSelection: { type: "text", anchor: 2, head: 2 },
      document: draft, draft, defaultPrevented: key === "Delete",
    })
  })

  it("does not import an external native range into the focused composer", async () => {
    const probeRef: Probe = { current: null }
    render(<><div data-testid="native-external-range">external</div><Harness {...props} probeRef={probeRef} draftKey="native-external" /></>)
    const editor = await editorOf(probeRef)
    await type(editor, "@")
    let result: object = {}
    act(() => {
      const range = document.createRange()
      range.selectNodeContents(screen.getByTestId("native-external-range"))
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const focusedBefore = editor.view.hasFocus()
      dispatchDeletion(editor, "Delete")
      result = {
        focusedBefore, nativeText: selection.toString(), text: editor.getText(),
        modelSelection: editor.state.selection.toJSON(), draft: readComposerDraft("viewer:native-external"),
      }
    })
    expect(result).toEqual({
      focusedBefore: true, nativeText: "external", text: "@",
      modelSelection: { type: "text", anchor: 2, head: 2 }, draft: editor.getJSON(),
    })
  })

  it.each(["blurred", "readonly"] as const)("does not import a native range into a %s composer", async (kind) => {
    const probeRef: Probe = { current: null }
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@" }] }] }
    writeComposerDraft("viewer:native-ineligible", draft)
    render(<Harness {...props} probeRef={probeRef} draftKey="native-ineligible" autoFocus />)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    let result: object = {}
    act(() => {
      if (kind === "blurred") editor.view.dom.blur()
      else editor.setEditable(false)
      const range = document.createRange()
      range.selectNodeContents(editor.view.dom)
      const native = document.getSelection()!
      native.removeAllRanges()
      native.addRange(range)
      const eligibleBefore = editor.view.hasFocus() && editor.view.editable
      dispatchDeletion(editor, "Delete")
      result = {
        eligibleBefore, nativeText: native.toString(), modelSelection: editor.state.selection.toJSON(),
        document: editor.getJSON(), draft: readComposerDraft("viewer:native-ineligible"),
      }
    })
    expect(result).toEqual({
      eligibleBefore: false, nativeText: "@", modelSelection: { type: "text", anchor: 2, head: 2 },
      document: draft, draft,
    })
  })

  it.each([false, true])("does not reconcile native ranges during IME, view composing: %s", async (viewComposing) => {
    const probeRef: Probe = { current: null }
    render(<Harness {...props} probeRef={probeRef} draftKey="native-ime" />)
    const editor = await editorOf(probeRef)
    await type(editor, "@")
    let result: object = {}
    act(() => {
      if (viewComposing) fireEvent.compositionStart(editor.view.dom)
      const range = document.createRange()
      range.selectNodeContents(editor.view.dom)
      const native = document.getSelection()!
      native.removeAllRanges()
      native.addRange(range)
      const composingBefore = editor.view.composing
      dispatchDeletion(editor, "Delete", { isComposing: true })
      result = {
        composingBefore, nativeText: native.toString(), text: editor.getText(),
        modelSelection: editor.state.selection.toJSON(), draft: readComposerDraft("viewer:native-ime"),
      }
      if (viewComposing) fireEvent.compositionEnd(editor.view.dom)
    })
    expect(result).toEqual({
      composingBefore: viewComposing, nativeText: "@", text: "@",
      modelSelection: { type: "text", anchor: 2, head: 2 }, draft: editor.getJSON(),
    })
  })

  it.each(["node", "all"] as const)("leaves ordinary %s selection deletion with the installed keymap", async (kind) => {
    const probeRef: Probe = { current: null }
    render(<Harness {...props} probeRef={probeRef} draftKey="native-framework-selection" />)
    const editor = await editorOf(probeRef)
    await act(async () => {
      editor.view.dom.focus()
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: kind === "node"
        ? [{ type: "mention", attrs: { id: ada.id, label: "Ada#0001" } }]
        : [{ type: "text", text: "@" }] }] })
      if (kind === "node") editor.commands.setNodeSelection(1)
      else editor.commands.selectAll()
    })
    let result: object = {}
    act(() => {
      const range = document.createRange()
      range.selectNodeContents(editor.view.dom)
      const native = document.getSelection()!
      native.removeAllRanges()
      native.addRange(range)
      const selectionTypeBefore = editor.state.selection.toJSON().type
      const deletion = dispatchDeletion(editor, "Delete")
      result = {
        selectionTypeBefore, document: editor.getJSON(), domText: editor.view.dom.textContent,
        isEmpty: editor.isEmpty, draft: readComposerDraft("viewer:native-framework-selection"),
        defaultPrevented: deletion.defaultPrevented,
      }
    })
    expect(result).toEqual({
      selectionTypeBefore: kind, document: { type: "doc", content: [{ type: "paragraph" }] },
      domText: "", isEmpty: true, draft: null, defaultPrevented: true,
    })
  })

  it("clears the selected trigger with the current mention popup open", async () => {
    const probeRef: Probe = { current: null }
    render(<Harness {...props} probeRef={probeRef} draftKey="native-popup" />)
    const editor = await editorOf(probeRef)
    await type(editor, "@a")
    await screen.findByTestId("community-mention-option-member-ada")
    act(() => {
      const range = document.createRange()
      range.selectNodeContents(editor.view.dom)
      const native = document.getSelection()!
      native.removeAllRanges()
      native.addRange(range)
      const deletion = dispatchDeletion(editor, "Delete")
      expect(deletion.defaultPrevented).toBe(true)
    })
    expect(editor.isEmpty).toBe(true)
    expect(editor.view.dom.textContent).toBe("")
    expect(readComposerDraft("viewer:native-popup")).toBeNull()
    expect(probeRef.current!.mentionPopup.command).toBeNull()
    expect(screen.queryByTestId("community-mention-popup")).toBeNull()
  })

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)("keeps %s Delete on the original path", async (modifier) => {
    const probeRef: Probe = { current: null }
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@" }] }] }
    writeComposerDraft("viewer:native-modified", draft)
    render(<Harness {...props} probeRef={probeRef} draftKey="native-modified" autoFocus />)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    let result: object = {}
    act(() => {
      const range = document.createRange()
      range.selectNodeContents(editor.view.dom)
      const native = document.getSelection()!
      native.removeAllRanges()
      native.addRange(range)
      dispatchDeletion(editor, "Delete", { [modifier]: true })
      result = {
        nativeText: native.toString(), modelSelection: editor.state.selection.toJSON(),
        document: editor.getJSON(), draft: readComposerDraft("viewer:native-modified"),
      }
    })
    expect(result).toEqual({
      nativeText: "@", modelSelection: { type: "text", anchor: 2, head: 2 }, document: draft, draft,
    })
  })

  it.each(["RangeError", "TypeError"] as const)("declines invalid mapping but exposes an unexpected %s", async (kind) => {
    const probeRef: Probe = { current: null }
    const draft = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@" }] }] }
    writeComposerDraft("viewer:native-mapping", draft)
    render(<Harness {...props} probeRef={probeRef} draftKey="native-mapping" autoFocus />)
    const editor = await editorOf(probeRef)
    await waitFor(() => expect(editor.isFocused).toBe(true))
    const failure = kind === "RangeError" ? new RangeError("invalid native position") : new TypeError("unexpected mapping failure")
    vi.spyOn(editor.view, "posAtDOM").mockImplementation(() => { throw failure })
    let reported: unknown
    const onError = (event: ErrorEvent) => { reported = event.error; event.preventDefault() }
    window.addEventListener("error", onError)
    try {
      act(() => {
        const range = document.createRange()
        range.selectNodeContents(editor.view.dom)
        const native = document.getSelection()!
        native.removeAllRanges()
        native.addRange(range)
        dispatchDeletion(editor, "Delete")
      })
      expect(reported).toBe(kind === "RangeError" ? undefined : failure)
      expect(editor.state.selection.toJSON()).toEqual({ type: "text", anchor: 2, head: 2 })
      expect(editor.getJSON()).toEqual(draft)
      expect(readComposerDraft("viewer:native-mapping")).toEqual(draft)
    } finally {
      window.removeEventListener("error", onError)
    }
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
