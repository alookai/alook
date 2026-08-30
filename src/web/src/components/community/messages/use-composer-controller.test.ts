import { readFileSync } from "node:fs"
import { forwardRef, createElement, createRef } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useEditor: vi.fn(),
  useFileAttachments: vi.fn(),
  useSuggestions: vi.fn(),
  clearDraft: vi.fn(),
  readDraft: vi.fn(),
  writeDraft: vi.fn(),
  detectMentionType: vi.fn(),
  addPendingFiles: vi.fn(),
  restorePendingFiles: vi.fn(),
  appendAttachmentSession: vi.fn(),
  clearAttachmentSession: vi.fn(),
  readAttachmentSession: vi.fn(),
  removeAttachmentFiles: vi.fn(),
  transferAttachmentSession: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  starterConfigure: vi.fn(),
  placeholderConfigure: vi.fn(),
  buildPasteDom: vi.fn(),
  fromSchema: vi.fn(),
  parseSlice: vi.fn(),
  normalizeHardBreak: vi.fn(),
  composerDocumentExtensions: vi.fn(),
  preservePlainTextPaste: vi.fn(),
  serializeDocument: vi.fn(),
  hoverCapable: true,
}))

vi.mock("@tiptap/react", () => ({
  useEditor: (...args: unknown[]) => mocks.useEditor(...args),
}))
vi.mock("@tiptap/starter-kit", () => ({
  default: {
    configure: (...args: unknown[]) => mocks.starterConfigure(...args),
  },
}))
vi.mock("@tiptap/extension-placeholder", () => ({
  default: {
    configure: (...args: unknown[]) => mocks.placeholderConfigure(...args),
  },
}))
vi.mock("@tiptap/pm/model", () => ({
  DOMParser: {
    fromSchema: (...args: unknown[]) => mocks.fromSchema(...args),
  },
}))
vi.mock("@/hooks/use-file-attachments", () => ({
  useFileAttachments: (...args: unknown[]) =>
    mocks.useFileAttachments(...args),
}))
vi.mock("@/hooks/use-hover-capable", () => ({
  useHoverCapable: () => mocks.hoverCapable,
}))
vi.mock("@/lib/community/composer-draft", () => ({
  clearComposerDraft: (...args: unknown[]) => mocks.clearDraft(...args),
  readComposerDraft: (...args: unknown[]) => mocks.readDraft(...args),
  writeComposerDraft: (...args: unknown[]) => mocks.writeDraft(...args),
}))
vi.mock("@/lib/community/composer-attachment-session", () => ({
  appendComposerAttachmentSession: (...args: unknown[]) => mocks.appendAttachmentSession(...args),
  clearComposerAttachmentSession: (...args: unknown[]) => mocks.clearAttachmentSession(...args),
  readComposerAttachmentSession: (...args: unknown[]) => mocks.readAttachmentSession(...args),
  removeComposerAttachmentSessionFiles: (...args: unknown[]) => mocks.removeAttachmentFiles(...args),
  transferComposerAttachmentSession: (...args: unknown[]) => mocks.transferAttachmentSession(...args),
}))
vi.mock("sonner", () => ({
  toast: {
    info: (...args: unknown[]) => mocks.toastInfo(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}))
vi.mock("@/lib/community/mention-extension", () => ({
  detectMentionType: (...args: unknown[]) => mocks.detectMentionType(...args),
}))
vi.mock("@/lib/community/paste-plain-text", () => ({
  buildPasteDom: (...args: unknown[]) => mocks.buildPasteDom(...args),
}))
vi.mock("./use-composer-suggestions", () => ({
  useComposerSuggestions: (...args: unknown[]) =>
    mocks.useSuggestions(...args),
}))
vi.mock("./consecutive-hard-break", () => ({
  normalizeConsecutiveTerminalHardBreak: (...args: unknown[]) =>
    mocks.normalizeHardBreak(...args),
}))
vi.mock("./composer-ordered-list", () => ({
  composerDocumentExtensions: (...args: unknown[]) =>
    mocks.composerDocumentExtensions(...args),
  preserveComposerPlainTextPaste: (...args: unknown[]) =>
    mocks.preservePlainTextPaste(...args),
  serializeComposerDocument: (...args: unknown[]) =>
    mocks.serializeDocument(...args),
}))

import { useComposerController } from "./use-composer-controller"
import type { ComposerHandle, ComposerProps } from "./composer-types"
import type { PendingFile } from "@/hooks/use-file-attachments"

type EditorOptions = {
  editorProps: {
    attributes: Record<string, string>
    handleKeyDown: (_view: unknown, event: KeyboardEvent) => boolean
    handlePaste: (_view: unknown, event: ClipboardEvent, slice?: unknown) => boolean
    clipboardTextParser: (text: string, context: never) => unknown
  }
  onUpdate: (props: { editor: TestEditor }) => void
}

type TestEditor = {
  isEmpty: boolean
  getText: ReturnType<typeof vi.fn>
  getJSON: ReturnType<typeof vi.fn>
  state: {
    tr: object
    selection: { from: number; to: number }
    doc: {
      content: { size: number }
      textBetween: ReturnType<typeof vi.fn>
    }
  }
  view: {
    dispatch: ReturnType<typeof vi.fn>
    dom: {
      setAttribute: ReturnType<typeof vi.fn>
    }
  }
  commands: {
    clearContent: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    liftEmptyBlock: ReturnType<typeof vi.fn>
    setContent: ReturnType<typeof vi.fn>
    splitListItem: ReturnType<typeof vi.fn>
    undoInputRule: ReturnType<typeof vi.fn>
  }
  chain: ReturnType<typeof vi.fn>
}

const Harness = forwardRef<ComposerHandle, ComposerProps>(
  function Harness(props, ref) {
    const view = useComposerController(props, ref)
    return createElement("controller-probe", { view })
  },
)

describe("useComposerController", () => {
  let editorOptions: EditorOptions
  let pendingFiles: PendingFile[]
  let editor: TestEditor
  let clearContent: ReturnType<typeof vi.fn>
  let focus: ReturnType<typeof vi.fn>
  let setContent: ReturnType<typeof vi.fn>
  let dispatch: ReturnType<typeof vi.fn>
  let setDomAttribute: ReturnType<typeof vi.fn>
  let transaction: object
  let chainFocus: ReturnType<typeof vi.fn>
  let insertContent: ReturnType<typeof vi.fn>
  let run: ReturnType<typeof vi.fn>
  let setPendingFiles: ReturnType<typeof vi.fn>
  let transferPendingFiles: ReturnType<typeof vi.fn>
  let awaitPendingFiles: ReturnType<typeof vi.fn>
  let resetPopups: ReturnType<typeof vi.fn>
  let filePickerClick: ReturnType<typeof vi.fn>
  let handleDropRaw: ReturnType<typeof vi.fn>
  let mentionPopupRef: { current: { items: unknown[]; command: null | ReturnType<typeof vi.fn> } }
  let channelRefPopupRef: { current: { items: unknown[]; command: null | ReturnType<typeof vi.fn> } }

  beforeEach(() => {
    vi.clearAllMocks()
    pendingFiles = []
    clearContent = vi.fn()
    focus = vi.fn()
    setContent = vi.fn()
    dispatch = vi.fn()
    setDomAttribute = vi.fn()
    transaction = {}
    run = vi.fn()
    insertContent = vi.fn(() => ({ run }))
    chainFocus = vi.fn(() => ({ insertContent }))
    setPendingFiles = vi.fn()
    transferPendingFiles = vi.fn()
    awaitPendingFiles = vi.fn(async () => pendingFiles)
    resetPopups = vi.fn()
    filePickerClick = vi.fn()
    handleDropRaw = vi.fn()
    mentionPopupRef = { current: { items: [], command: null } }
    channelRefPopupRef = { current: { items: [], command: null } }
    editor = {
      isEmpty: false,
      getText: vi.fn(() => "  hello @everyone  "),
      getJSON: vi.fn(() => ({ type: "doc" })),
      state: {
        tr: transaction,
        selection: { from: 5, to: 5 },
        doc: {
          content: { size: 10 },
          textBetween: vi.fn((from: number, to: number) => to === 5 ? "o" : from === 5 ? "w" : ""),
        },
      },
      view: { dispatch, dom: { setAttribute: setDomAttribute } },
      commands: {
        clearContent,
        focus,
        liftEmptyBlock: vi.fn(() => false),
        setContent,
        splitListItem: vi.fn(() => false),
        undoInputRule: vi.fn(() => false),
      },
      chain: vi.fn(() => ({ focus: chainFocus })),
    }
    mocks.starterConfigure.mockReturnValue({ name: "starter-kit" })
    mocks.composerDocumentExtensions.mockReturnValue([{ name: "document-extensions" }])
    mocks.preservePlainTextPaste.mockReturnValue(true)
    mocks.serializeDocument.mockImplementation((currentEditor: TestEditor) =>
      currentEditor.getText({ blockSeparator: "\n\n" }),
    )
    mocks.placeholderConfigure.mockReturnValue({ name: "placeholder" })
    mocks.fromSchema.mockReturnValue({ parseSlice: mocks.parseSlice })
    mocks.useEditor.mockImplementation((options) => {
      editorOptions = options
      return editor
    })
    mocks.useFileAttachments.mockImplementation(() => ({
      pendingFiles,
      setPendingFiles,
      transferPendingFiles,
      restorePendingFiles: mocks.restorePendingFiles,
      awaitPendingFiles,
      addPendingFiles: mocks.addPendingFiles,
      fileInputRef: { current: { click: filePickerClick } },
      handleFileSelect: vi.fn(),
      removePendingFile: vi.fn(),
      dragging: false,
      handleDragEnter: vi.fn(),
      handleDragLeave: vi.fn(),
      handleDragOver: vi.fn(),
      handleDrop: handleDropRaw,
    }))
    mocks.useSuggestions.mockImplementation(() => ({
      mentionPopup: { items: [], selectedIndex: 0, command: null, getRect: null },
      mentionPresentation: { status: "ready" },
      mentionPopupRef,
      mentionExtension: { name: "mention" },
      channelRefPopup: { items: [], selectedIndex: 0, command: null, getRect: null },
      channelRefPresentation: { status: "loading" },
      channelRefPopupRef,
      channelRefExtension: { name: "channel-ref" },
      resetPopups,
    }))
    mocks.detectMentionType.mockReturnValue("everyone")
    mocks.normalizeHardBreak.mockReturnValue(false)
    mocks.readDraft.mockReturnValue(null)
    mocks.readAttachmentSession.mockReturnValue([])
    mocks.appendAttachmentSession.mockReturnValue({ accepted: true, evictedScopes: 0 })
    mocks.restorePendingFiles.mockResolvedValue(undefined)
    mocks.hoverCapable = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const acceptedProps = (
    onAcceptSend: Extract<
      ComposerProps,
      { sendContract: "accepted" }
    >["onAcceptSend"],
  ): ComposerProps => ({
    channel: "general",
    context: "channel",
    members: [],
    sendContract: "accepted",
    onAcceptSend,
    draftKey: "server/channel",
  })

  const enter = async (shiftKey = false) => {
    const preventDefault = vi.fn()
    await act(async () => {
      editorOptions.editorProps.handleKeyDown({} as never, {
        key: "Enter",
        shiftKey,
        isComposing: false,
        preventDefault,
      } as unknown as KeyboardEvent)
      await Promise.resolve()
      await Promise.resolve()
    })
    return preventDefault
  }

  it("enables the Community thumbnail policy at the composer boundary", async () => {
    await act(async () => {
      TestRenderer.create(createElement(Harness, acceptedProps(vi.fn(() => true))))
    })

    expect(mocks.useFileAttachments).toHaveBeenCalledWith(expect.objectContaining({
      maxFileSize: 25 * 1024 * 1024,
      maxFiles: 10,
      thumbnailPolicy: "community",
      draftSessionScope: "server/channel",
    }))
  })

  it("forwards the optional channel source into suggestions and its presentation into the view", async () => {
    const channelRefCandidateSource = { loading: true, failed: false }
    const props = {
      ...acceptedProps(vi.fn(() => true)),
      channelRefCandidateSource,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })

    expect(mocks.useSuggestions).toHaveBeenCalledWith(expect.objectContaining({
      channelRefCandidateSource,
    }))
    expect(renderer.root.findByType("controller-probe").props.view)
      .toMatchObject({
        channelRefPresentation: { status: "loading" },
      })
  })

  it("retains everything after false/throw, unlocks, and clears only on accepted true", async () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" })
    pendingFiles = [{ file, thumbnailUrl: null, thumbnailBlob: null }]
    const reject = vi.fn(() => false)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, acceptedProps(reject)))
    })
    await enter()
    expect(reject).toHaveBeenCalledWith(
      "hello @everyone",
      [
        {
          file,
          previewObjectUrl: undefined,
          width: undefined,
          height: undefined,
        },
      ],
      "everyone",
    )
    expect(clearContent).not.toHaveBeenCalled()
    expect(mocks.clearDraft).not.toHaveBeenCalled()
    expect(transferPendingFiles).not.toHaveBeenCalled()
    expect(resetPopups).not.toHaveBeenCalled()

    const throws = vi.fn(() => {
      throw new Error("rejected")
    })
    await act(async () => {
      renderer.update(createElement(Harness, acceptedProps(throws)))
    })
    await enter()
    expect(throws).toHaveBeenCalledOnce()
    expect(clearContent).not.toHaveBeenCalled()
    expect(transferPendingFiles).not.toHaveBeenCalled()
    expect(resetPopups).not.toHaveBeenCalled()

    const accept = vi.fn(() => true)
    await act(async () => {
      renderer.update(createElement(Harness, acceptedProps(accept)))
    })
    await enter()
    expect(accept).toHaveBeenCalledOnce()
    expect(clearContent).toHaveBeenCalledOnce()
    expect(mocks.clearDraft).toHaveBeenCalledWith("server/channel")
    expect(transferPendingFiles).toHaveBeenCalledOnce()
    expect(resetPopups).toHaveBeenCalledOnce()
    expect(clearContent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearDraft.mock.invocationCallOrder[0],
    )
    expect(mocks.clearDraft.mock.invocationCallOrder[0]).toBeLessThan(
      transferPendingFiles.mock.invocationCallOrder[0],
    )
    expect(transferPendingFiles.mock.invocationCallOrder[0]).toBeLessThan(
      resetPopups.mock.invocationCallOrder[0],
    )
  })

  it("awaits deferred resolve/reject without Composer-owned cleanup", async () => {
    let resolve!: () => void
    const deferred = new Promise<void>((done) => {
      resolve = done
    })
    const submit = vi.fn(() => deferred)
    const props: ComposerProps = {
      channel: "forum",
      context: "channel",
      members: [],
      sendContract: "deferred",
      mode: "forumThreadBody",
      onDeferredSubmit: submit,
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })
    await enter(true)
    await enter(true)
    expect(submit).toHaveBeenCalledOnce()
    expect(clearContent).not.toHaveBeenCalled()
    await act(async () => {
      resolve()
      await deferred
    })
    expect(clearContent).not.toHaveBeenCalled()
    expect(setPendingFiles).not.toHaveBeenCalled()
    expect(transferPendingFiles).not.toHaveBeenCalled()
    expect(resetPopups).not.toHaveBeenCalled()

    const rejected = vi.fn(async () => {
      throw new Error("mutation failed")
    })
    mocks.hoverCapable = false
    await act(async () => {
      renderer.update(
        createElement(Harness, { ...props, onDeferredSubmit: rejected }),
      )
    })
    await enter(true)
    expect(rejected).toHaveBeenCalledOnce()
    await enter(true)
    expect(rejected).toHaveBeenCalledTimes(2)
    expect(clearContent).not.toHaveBeenCalled()
    expect(resetPopups).not.toHaveBeenCalled()
  })

  it("reads popup refs at keydown time and preserves handle/paste semantics", async () => {
    const accept = vi.fn(() => true)
    const handleRef = createRef<ComposerHandle>()
    await act(async () => {
      TestRenderer.create(
        createElement(Harness, { ...acceptedProps(accept), ref: handleRef }),
      )
    })
    mentionPopupRef.current = { items: [{}], command: vi.fn() }
    const blocked = vi.fn()
    expect(
      editorOptions.editorProps.handleKeyDown({} as never, {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: blocked,
      } as unknown as KeyboardEvent),
    ).toBe(false)
    expect(blocked).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()

    mentionPopupRef.current = { items: [], command: vi.fn() }
    await enter()
    expect(accept).toHaveBeenCalledOnce()

    const file = new File(["x"], "paste.png", { type: "image/png" })
    const items = {
      0: { kind: "file", getAsFile: () => file },
      length: 1,
    } as unknown as DataTransferItemList
    const preventDefault = vi.fn()
    expect(
      editorOptions.editorProps.handlePaste({} as never, {
        clipboardData: { items },
        preventDefault,
      } as unknown as ClipboardEvent),
    ).toBe(true)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.addPendingFiles).toHaveBeenCalledWith([file])
    const pasteView = { state: {} }
    const pasteSlice = { content: "parsed clipboard" }
    expect(
      editorOptions.editorProps.handlePaste(pasteView, {
        clipboardData: {
          items: { length: 0 },
          getData: (type: string) => type === "text/plain" ? "x".repeat(1_000) : "",
        },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent, pasteSlice),
    ).toBe(true)
    expect(mocks.preservePlainTextPaste).toHaveBeenCalledWith(
      pasteView,
      "x".repeat(1_000),
      "",
      pasteSlice,
    )

    const preventLongPaste = vi.fn()
    expect(
      editorOptions.editorProps.handlePaste({} as never, {
        clipboardData: {
          items: { length: 0 },
          getData: () => "x".repeat(1_001),
        },
        preventDefault: preventLongPaste,
      } as unknown as ClipboardEvent),
    ).toBe(true)
    expect(preventLongPaste).toHaveBeenCalledOnce()
    const firstLongPasteFile = mocks.addPendingFiles.mock.calls.at(-1)?.[0][0] as File
    expect(firstLongPasteFile.name).toBe("copy-1.md")
    expect(firstLongPasteFile.type).toBe("text/markdown")
    expect(await firstLongPasteFile.text()).toBe("x".repeat(1_001))

    expect(
      editorOptions.editorProps.handlePaste({} as never, {
        clipboardData: {
          items: { length: 0 },
          getData: () => "y".repeat(1_001),
        },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent),
    ).toBe(true)
    const secondLongPasteFile = mocks.addPendingFiles.mock.calls.at(-1)?.[0][0] as File
    expect(secondLongPasteFile.name).toBe("copy-2.md")

    handleRef.current?.focusEditor()
    expect(focus).toHaveBeenCalledWith("end")
    handleRef.current?.insertTextAtCaret("@Alice Smith#0042")
    expect(editor.chain).toHaveBeenCalled()
    expect(chainFocus).toHaveBeenCalled()
    expect(insertContent).toHaveBeenCalledWith({
      type: "text",
      text: " @Alice Smith#0042 ",
    })
    handleRef.current?.insertMentionAtCaret({
      id: "member_1",
      label: "Alice Smith#0042",
    })
    expect(insertContent).toHaveBeenLastCalledWith([
      { type: "text", text: " " },
      {
        type: "mention",
        attrs: { id: "member_1", label: "Alice Smith#0042" },
      },
      { type: "text", text: " " },
    ])
    expect(run).toHaveBeenCalled()
    handleRef.current?.openFilePicker()
    expect(filePickerClick).toHaveBeenCalledOnce()
    expect(handleRef.current?.isEmpty()).toBe(false)
    const transfersBeforeReset = transferPendingFiles.mock.calls.length
    handleRef.current?.resetAfterSubmit()
    expect(setPendingFiles).toHaveBeenCalledWith([])
    expect(resetPopups).toHaveBeenCalled()
    expect(transferPendingFiles).toHaveBeenCalledTimes(transfersBeforeReset)

    expect(
      editorOptions.editorProps.handlePaste({} as never, {
        clipboardData: {
          items: { length: 0 },
          getData: () => "z".repeat(1_001),
        },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent),
    ).toBe(true)
    const afterResetFile = mocks.addPendingFiles.mock.calls.at(-1)?.[0][0] as File
    expect(afterResetFile.name).toBe("copy-1.md")
  })

  it("passes the canonical channel and DM draft scopes into the attachment hook", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    const accept = vi.fn(() => true)
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, acceptedProps(accept)))
    })
    expect(mocks.useFileAttachments).toHaveBeenLastCalledWith(expect.objectContaining({
      draftSessionScope: "server/channel",
    }))

    await act(async () => {
      renderer.update(createElement(Harness, {
        ...acceptedProps(accept),
        channel: "person",
        context: "dm",
        draftKey: "dm/person",
      }))
    })
    expect(mocks.useFileAttachments).toHaveBeenLastCalledWith(expect.objectContaining({
      draftSessionScope: "dm/person",
    }))
  })

  it("skips long-paste names already used by pending files", async () => {
    const props = acceptedProps(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })

    const existingFile = new File(["existing"], "copy-1.md", {
      type: "text/markdown",
    })
    pendingFiles = [
      { file: existingFile, thumbnailUrl: null, thumbnailBlob: null },
    ]
    await act(async () => {
      renderer.update(createElement(Harness, props))
    })

    expect(
      editorOptions.editorProps.handlePaste({} as never, {
        clipboardData: {
          items: { length: 0 },
          getData: () => "x".repeat(1_001),
        },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent),
    ).toBe(true)
    const attachment = mocks.addPendingFiles.mock.calls.at(-1)?.[0][0] as File
    expect(attachment.name).toBe("copy-2.md")
  })

  it("retains one TipTap editor instance while render-time configuration reruns", async () => {
    const accept = vi.fn(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, acceptedProps(accept)),
      )
    })
    const firstEditor = renderer.root.findByType("controller-probe").props.view
      .editor
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          members: [
            {
              id: "member-1",
              userId: "user-1",
              name: "Ada",
              discriminator: "0001",
              avatar: "A",
              status: "online",
            },
          ],
        }),
      )
    })
    const secondEditor = renderer.root.findByType("controller-probe").props.view
      .editor
    expect(secondEditor).toBe(firstEditor)
    expect(mocks.useEditor).toHaveBeenCalledTimes(2)
    expect(mocks.composerDocumentExtensions).toHaveBeenCalledTimes(2)
    expect(mocks.composerDocumentExtensions).toHaveBeenNthCalledWith(1, false)
    expect(mocks.composerDocumentExtensions).toHaveBeenNthCalledWith(2, false)
    expect(mocks.placeholderConfigure).toHaveBeenCalledTimes(2)
  })

  it("keeps one live input-capability contract across coarse and hover-capable inputs", async () => {
    mocks.hoverCapable = false
    const accept = vi.fn(() => true)
    const props = acceptedProps(accept)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })
    const stableHandleKeyDown = editorOptions.editorProps.handleKeyDown
    const key = (overrides: Partial<KeyboardEvent> = {}) => ({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      preventDefault: vi.fn(),
      ...overrides,
    }) as unknown as KeyboardEvent

    const coarseEnter = key()
    expect(stableHandleKeyDown({} as never, coarseEnter)).toBe(false)
    expect(coarseEnter.preventDefault).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()
    expect(setDomAttribute).toHaveBeenLastCalledWith("enterkeyhint", "enter")
    expect(renderer.root.findByType("controller-probe").props.view.showSend).toBe(true)

    mocks.hoverCapable = true
    await act(async () => {
      renderer.update(createElement(Harness, props))
    })
    const fineShiftEnter = key({ shiftKey: true })
    expect(stableHandleKeyDown({} as never, fineShiftEnter)).toBe(false)
    expect(fineShiftEnter.preventDefault).not.toHaveBeenCalled()
    const fineEnter = key()
    expect(stableHandleKeyDown({} as never, fineEnter)).toBe(true)
    expect(fineEnter.preventDefault).toHaveBeenCalledOnce()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledOnce()
    expect(setDomAttribute).toHaveBeenLastCalledWith("enterkeyhint", "send")
    expect(renderer.root.findByType("controller-probe").props.view.showSend).toBe(false)

    mocks.hoverCapable = false
    await act(async () => {
      renderer.update(createElement(Harness, props))
    })
    mentionPopupRef.current = { items: [{}], command: vi.fn() }
    const suggestionEnter = key()
    expect(stableHandleKeyDown({} as never, suggestionEnter)).toBe(false)
    expect(suggestionEnter.preventDefault).not.toHaveBeenCalled()
    mentionPopupRef.current = { items: [], command: null }
    const composingEnter = key({ isComposing: true })
    expect(stableHandleKeyDown({} as never, composingEnter)).toBe(false)
    expect(composingEnter.preventDefault).not.toHaveBeenCalled()
    expect(accept).toHaveBeenCalledOnce()
    expect(setDomAttribute).toHaveBeenLastCalledWith("enterkeyhint", "enter")
  })

  it("projects explicit send eligibility from text, pending files, and single-flight", async () => {
    mocks.hoverCapable = false
    editor.isEmpty = true
    let releaseFiles!: () => void
    const fileGate = new Promise<void>((resolve) => {
      releaseFiles = resolve
    })
    awaitPendingFiles.mockImplementation(async () => {
      await fileGate
      return pendingFiles
    })
    const accept = vi.fn(() => true)
    const props = acceptedProps(accept)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })
    const view = () => renderer.root.findByType("controller-probe").props.view
    expect(view()).toMatchObject({ showSend: true, sendDisabled: true })

    editor.isEmpty = false
    await act(async () => {
      editorOptions.onUpdate({ editor })
    })
    expect(view().sendDisabled).toBe(false)
    await act(async () => {
      view().onSend()
      view().onSend()
    })
    expect(awaitPendingFiles).toHaveBeenCalledOnce()
    expect(view().sendDisabled).toBe(true)
    expect(accept).not.toHaveBeenCalled()
    await act(async () => {
      releaseFiles()
      await fileGate
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledOnce()
    expect(view().sendDisabled).toBe(true)

    editor.isEmpty = true
    pendingFiles = [{
      file: new File(["x"], "pending.txt", { type: "text/plain" }),
      thumbnailUrl: null,
      thumbnailBlob: null,
    }]
    await act(async () => {
      renderer.update(createElement(Harness, props))
    })
    expect(view().sendDisabled).toBe(false)
  })

  it("updates the live placeholder without replacing or resetting the editor", async () => {
    const props = acceptedProps(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })
    const firstEditor = renderer.root.findByType("controller-probe").props.view
      .editor
    const livePlaceholder = mocks.placeholderConfigure.mock.calls[0]?.[0]
      .placeholder as () => string
    expect(livePlaceholder()).toBe("Message /general")
    expect(dispatch).not.toHaveBeenCalled()

    await act(async () => {
      renderer.update(
        createElement(Harness, { ...props, channel: "renamed-channel" }),
      )
    })
    expect(renderer.root.findByType("controller-probe").props.view.editor).toBe(
      firstEditor,
    )
    expect(livePlaceholder()).toBe("Message /renamed-channel")
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenLastCalledWith(transaction)

    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...props,
          channel: "another-channel",
          placeholder: "Custom composer prompt",
        }),
      )
    })
    expect(livePlaceholder()).toBe("Custom composer prompt")
    expect(dispatch).toHaveBeenCalledTimes(2)

    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...props,
          channel: "final-channel",
          placeholder: "Custom composer prompt",
        }),
      )
    })
    expect(livePlaceholder()).toBe("Custom composer prompt")
    expect(dispatch).toHaveBeenCalledTimes(2)

    await act(async () => {
      renderer.update(
        createElement(Harness, { ...props, channel: "final-channel" }),
      )
    })
    expect(livePlaceholder()).toBe("Message /final-channel")
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(clearContent).not.toHaveBeenCalled()
    expect(setContent).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(mocks.clearDraft).not.toHaveBeenCalled()
    expect(mocks.writeDraft).not.toHaveBeenCalled()
  })

  it("restores valid JSON without typing, dirty, or draft-write side effects", async () => {
    const doc = { type: "doc", content: [{ type: "paragraph" }] }
    const onTyping = vi.fn()
    const onDirty = vi.fn()
    mocks.readDraft.mockReturnValue(doc)
    setContent.mockImplementation(() => {
      editorOptions.onUpdate({ editor })
    })
    await act(async () => {
      TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(() => true),
          onTyping,
          onDirty,
        }),
      )
    })
    expect(mocks.readDraft).toHaveBeenCalledWith("server/channel")
    expect(setContent).toHaveBeenCalledWith(doc, {
      emitUpdate: false,
      errorOnInvalidContent: true,
    })
    expect(onTyping).not.toHaveBeenCalled()
    expect(mocks.writeDraft).not.toHaveBeenCalled()
    expect(mocks.clearDraft).not.toHaveBeenCalled()
  })

  it("clears only a corrupt draft and always releases the restoring guard", async () => {
    const onTyping = vi.fn()
    mocks.readDraft.mockReturnValue({ type: "broken" })
    setContent.mockImplementation(() => {
      throw new Error("invalid content")
    })
    await act(async () => {
      TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(() => true),
          onTyping,
        }),
      )
    })
    expect(mocks.clearDraft).toHaveBeenCalledTimes(1)
    expect(mocks.clearDraft).toHaveBeenCalledWith("server/channel")

    await act(async () => {
      editorOptions.onUpdate({ editor })
    })
    expect(onTyping).toHaveBeenCalledOnce()
    expect(mocks.writeDraft).toHaveBeenCalledWith("server/channel", {
      type: "doc",
    })
  })

  it("runs leading-edge typing and dirty transitions only from onUpdate", async () => {
    vi.useFakeTimers()
    editor.isEmpty = true
    const onTyping = vi.fn()
    const onDirty = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(() => true),
          onTyping,
          onDirty,
        }),
      )
    })
    expect(onTyping).not.toHaveBeenCalled()
    expect(onDirty).not.toHaveBeenCalled()

    editor.isEmpty = false
    await act(async () => {
      editorOptions.onUpdate({ editor })
      editorOptions.onUpdate({ editor })
    })
    expect(onTyping).toHaveBeenCalledOnce()
    expect(onDirty).toHaveBeenCalledTimes(1)
    expect(onDirty).toHaveBeenLastCalledWith(true)
    expect(mocks.writeDraft).toHaveBeenLastCalledWith("server/channel", {
      type: "doc",
    })

    editor.isEmpty = true
    await act(async () => {
      editorOptions.onUpdate({ editor })
    })
    expect(onTyping).toHaveBeenCalledOnce()
    expect(onDirty).toHaveBeenLastCalledWith(false)
    expect(mocks.writeDraft).toHaveBeenLastCalledWith("server/channel", null)

    await act(async () => {
      vi.advanceTimersByTime(3_000)
    })
    editor.isEmpty = false
    await act(async () => {
      editorOptions.onUpdate({ editor })
    })
    expect(onTyping).toHaveBeenCalledTimes(2)
    expect(onDirty.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
      true,
    ])
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => renderer.unmount())
    expect(vi.getTimerCount()).toBe(1)
  })

  it("skips all draft restore and chat focus effects in forum mode", async () => {
    const props: ComposerProps = {
      channel: "forum",
      context: "channel",
      members: [],
      sendContract: "deferred",
      mode: "forumThreadBody",
      onDeferredSubmit: vi.fn(),
      autoFocus: true,
      draftKey: "ignored/forum",
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Harness, props))
    })
    expect(mocks.readDraft).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...props,
          replyingTo: { authorName: "Ada", text: "First target" },
        }),
      )
    })
    expect(focus).not.toHaveBeenCalled()
  })

  it("preserves autofocus, reply edge, drop, dropdown, upload, and emoji timing", async () => {
    const accept = vi.fn(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(accept),
          autoFocus: true,
        }),
      )
    })
    expect(focus).toHaveBeenCalledWith("end")
    focus.mockClear()

    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          autoFocus: true,
          members: [],
        }),
      )
    })
    expect(focus).not.toHaveBeenCalled()
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          channel: "random",
          draftKey: "server/random",
          autoFocus: true,
        }),
      )
    })
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenLastCalledWith("end")

    focus.mockClear()
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          channel: "random",
          draftKey: "server/random",
          replyingTo: { authorName: "Ada", text: "First target" },
        }),
      )
    })
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenLastCalledWith("end")
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          channel: "random",
          draftKey: "server/random",
          replyingTo: { authorName: "Grace", text: "Second target" },
        }),
      )
    })
    expect(focus).toHaveBeenCalledTimes(2)
    expect(focus).toHaveBeenLastCalledWith("end")
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          channel: "random",
          draftKey: "server/random",
        }),
      )
    })
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          channel: "random",
          draftKey: "server/random",
          replyingTo: { authorName: "Ada", text: "First target" },
        }),
      )
    })
    expect(focus).toHaveBeenCalledTimes(3)

    const view = renderer.root.findByType("controller-probe").props.view
    focus.mockClear()
    await act(async () => view.onDrop({ type: "drop" }))
    expect(handleDropRaw).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith()
    expect(handleDropRaw.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0],
    )

    focus.mockClear()
    view.onUploadFile()
    expect(filePickerClick).toHaveBeenCalledOnce()
    expect(focus).not.toHaveBeenCalled()

    view.onEmojiPick("🌱")
    expect(editor.chain).toHaveBeenCalled()
    expect(chainFocus).toHaveBeenCalled()
    expect(insertContent).toHaveBeenCalledWith("🌱")
    expect(run).toHaveBeenCalled()
    expect(chainFocus.mock.invocationCallOrder.at(-1)).toBeLessThan(
      insertContent.mock.invocationCallOrder.at(-1),
    )
    expect(insertContent.mock.invocationCallOrder.at(-1)).toBeLessThan(
      run.mock.invocationCallOrder.at(-1),
    )
  })

  it("uses the same single-flight gate for submitNow and checks editor plus files", async () => {
    let releaseFiles!: () => void
    const fileGate = new Promise<void>((resolve) => {
      releaseFiles = resolve
    })
    awaitPendingFiles.mockImplementation(async () => {
      await fileGate
      return pendingFiles
    })
    const accept = vi.fn(() => true)
    const handleRef = createRef<ComposerHandle>()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, { ...acceptedProps(accept), ref: handleRef }),
      )
    })
    handleRef.current?.submitNow()
    handleRef.current?.submitNow()
    expect(awaitPendingFiles).toHaveBeenCalledOnce()
    expect(accept).not.toHaveBeenCalled()
    await act(async () => {
      releaseFiles()
      await fileGate
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledOnce()

    editor.isEmpty = true
    pendingFiles = []
    await act(async () => {
      renderer.update(
        createElement(Harness, { ...acceptedProps(accept), ref: handleRef }),
      )
    })
    expect(handleRef.current?.isEmpty()).toBe(true)

    pendingFiles = [
      {
        file: new File(["x"], "pending.txt", { type: "text/plain" }),
        thumbnailUrl: null,
        thumbnailBlob: null,
      },
    ]
    await act(async () => {
      renderer.update(
        createElement(Harness, { ...acceptedProps(accept), ref: handleRef }),
      )
    })
    expect(handleRef.current?.isEmpty()).toBe(false)

    pendingFiles = []
    editor.isEmpty = false
    await act(async () => {
      renderer.update(
        createElement(Harness, { ...acceptedProps(accept), ref: handleRef }),
      )
    })
    expect(handleRef.current?.isEmpty()).toBe(false)
  })

  it("preserves the full key priority matrix and text parser pipeline", async () => {
    const accept = vi.fn(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, acceptedProps(accept)),
      )
    })
    const key = (
      overrides: Partial<KeyboardEvent> = {},
    ): KeyboardEvent =>
      ({
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
        ...overrides,
      }) as unknown as KeyboardEvent

    const editorView = { identity: "real-view" }
    channelRefPopupRef.current = { items: [{}], command: vi.fn() }
    expect(editorOptions.editorProps.handleKeyDown(editorView, key())).toBe(
      false,
    )
    expect(mocks.normalizeHardBreak).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()
    channelRefPopupRef.current = { items: [], command: vi.fn() }

    mentionPopupRef.current = { items: [{}], command: vi.fn() }
    expect(editorOptions.editorProps.handleKeyDown(editorView, key())).toBe(
      false,
    )
    expect(mocks.normalizeHardBreak).not.toHaveBeenCalled()
    mentionPopupRef.current = { items: [], command: vi.fn() }

    mocks.normalizeHardBreak.mockReturnValueOnce(true)
    const softBreak = key({ shiftKey: true })
    expect(
      editorOptions.editorProps.handleKeyDown(
        editorView,
        softBreak,
      ),
    ).toBe(true)
    expect(mocks.normalizeHardBreak).toHaveBeenCalledWith(editorView, softBreak)
    mocks.normalizeHardBreak.mockClear()

    expect(
      editorOptions.editorProps.handleKeyDown(
        editorView,
        key({ isComposing: true }),
      ),
    ).toBe(false)
    expect(mocks.normalizeHardBreak).not.toHaveBeenCalled()
    expect(accept).not.toHaveBeenCalled()

    editor.commands.undoInputRule.mockReturnValueOnce(true)
    const undoKey = key({ key: "z", metaKey: true })
    expect(editorOptions.editorProps.handleKeyDown(editorView, undoKey)).toBe(
      true,
    )
    expect(editor.commands.undoInputRule).toHaveBeenCalledOnce()
    expect(undoKey.preventDefault).toHaveBeenCalledOnce()

    const forumProps: ComposerProps = {
      channel: "forum",
      context: "channel",
      members: [],
      sendContract: "deferred",
      mode: "forumThreadBody",
      onDeferredSubmit: vi.fn(),
    }
    await act(async () => {
      renderer.update(createElement(Harness, forumProps))
    })
    const forumSubmit = forumProps.onDeferredSubmit
    expect(editorOptions.editorProps.handleKeyDown({} as never, key())).toBe(
      false,
    )
    expect(
      editorOptions.editorProps.handleKeyDown(
        {} as never,
        key({ shiftKey: true, isComposing: true }),
      ),
    ).toBe(false)
    expect(forumSubmit).not.toHaveBeenCalled()

    const dom = { nodeName: "DIV" }
    const slice = { openStart: 1, openEnd: 1 }
    const schema = { name: "schema" }
    const context = { doc: { type: { schema } } }
    mocks.buildPasteDom.mockReturnValue(dom)
    mocks.parseSlice.mockReturnValue(slice)
    vi.stubGlobal("document", { body: {} })
    expect(
      editorOptions.editorProps.clipboardTextParser(
        "first\nsecond\n\nthird",
        context as never,
      ),
    ).toBe(slice)
    expect(mocks.buildPasteDom).toHaveBeenCalledWith(
      "first\nsecond\n\nthird",
      document,
    )
    expect(mocks.fromSchema).toHaveBeenCalledWith(schema)
    expect(mocks.parseSlice).toHaveBeenCalledWith(dom, {
      preserveWhitespace: true,
      context,
    })
  })

  it("pins the layout/draft/typing ordering boundaries in source", () => {
    const source = readFileSync(new URL("./use-composer-controller.ts", import.meta.url), "utf8")
    const gate = source.indexOf("if (!editor || sendInFlightRef.current) return")
    const awaitFiles = source.indexOf("await awaitPendingFiles()")
    const secondCheck = source.indexOf("lifecycleVersionRef.current !== attemptLifecycle")
    const empty = source.indexOf("editor.isEmpty && preparedFiles.length === 0")
    const markdown = source.indexOf("const markdown =")
    expect(gate).toBeLessThan(awaitFiles)
    expect(awaitFiles).toBeLessThan(secondCheck)
    expect(secondCheck).toBeLessThan(empty)
    expect(empty).toBeLessThan(markdown)
    expect(source).toContain("sendRef.current = send")
    expect(source).toContain("useLayoutEffect(")
    expect(source).toContain("emitUpdate: false")
    expect(source).toContain("errorOnInvalidContent: true")
    expect(source).toContain("restoringDraftRef.current = false")
    expect(source).toContain("3_000")
    expect(source).not.toContain("clearTimeout(")
  })
})
