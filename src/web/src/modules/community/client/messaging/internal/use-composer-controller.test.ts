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
  starterConfigure: vi.fn(),
  placeholderConfigure: vi.fn(),
  buildPasteDom: vi.fn(),
  fromSchema: vi.fn(),
  parseSlice: vi.fn(),
  refs: [] as Array<{ current: unknown }>,
  refInitialValues: [] as unknown[],
}))

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useRef: <T,>(initialValue: T) => {
      const ref = actual.useRef(initialValue)
      mocks.refs.push(ref as { current: unknown })
      mocks.refInitialValues.push(initialValue)
      return ref
    },
  }
})

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
vi.mock("@/lib/community/composer-draft", () => ({
  clearComposerDraft: (...args: unknown[]) => mocks.clearDraft(...args),
  readComposerDraft: (...args: unknown[]) => mocks.readDraft(...args),
  writeComposerDraft: (...args: unknown[]) => mocks.writeDraft(...args),
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

import { useComposerController } from "./use-composer-controller"
import type { ComposerHandle, ComposerProps } from "./composer-types"
import type { PendingFile } from "@/hooks/use-file-attachments"

type EditorOptions = {
  editorProps: {
    handleKeyDown: (_view: unknown, event: KeyboardEvent) => boolean
    handlePaste: (_view: unknown, event: ClipboardEvent) => boolean
    clipboardTextParser: (text: string, context: never) => unknown
  }
  onUpdate: (props: { editor: TestEditor }) => void
}

type TestEditor = {
  isEmpty: boolean
  getText: ReturnType<typeof vi.fn>
  getJSON: ReturnType<typeof vi.fn>
  commands: {
    clearContent: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    setContent: ReturnType<typeof vi.fn>
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
    mocks.refs.length = 0
    mocks.refInitialValues.length = 0
    pendingFiles = []
    clearContent = vi.fn()
    focus = vi.fn()
    setContent = vi.fn()
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
      commands: {
        clearContent,
        focus,
        setContent,
      },
      chain: vi.fn(() => ({ focus: chainFocus })),
    }
    mocks.starterConfigure.mockReturnValue({ name: "starter-kit" })
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
      mentionPopupRef,
      mentionExtension: { name: "mention" },
      channelRefPopup: { items: [], selectedIndex: 0, command: null, getRect: null },
      channelRefPopupRef,
      channelRefExtension: { name: "channel-ref" },
      resetPopups,
    }))
    mocks.detectMentionType.mockReturnValue("everyone")
    mocks.readDraft.mockReturnValue(null)
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
    expect(
      editorOptions.editorProps.handlePaste({} as never, {
        clipboardData: { items: { length: 0 } },
        preventDefault: vi.fn(),
      } as unknown as ClipboardEvent),
    ).toBe(false)

    handleRef.current?.focusEditor()
    expect(focus).toHaveBeenCalledWith("end")
    handleRef.current?.openFilePicker()
    expect(filePickerClick).toHaveBeenCalledOnce()
    expect(handleRef.current?.isEmpty()).toBe(false)
    const transfersBeforeReset = transferPendingFiles.mock.calls.length
    handleRef.current?.resetAfterSubmit()
    expect(setPendingFiles).toHaveBeenCalledWith([])
    expect(resetPopups).toHaveBeenCalled()
    expect(transferPendingFiles).toHaveBeenCalledTimes(transfersBeforeReset)
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
    expect(mocks.starterConfigure).toHaveBeenCalledTimes(2)
    expect(mocks.placeholderConfigure).toHaveBeenCalledTimes(2)
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
        createElement(Harness, { ...props, replyingTo: "Ada" }),
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
          replyingTo: "Ada",
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
          replyingTo: "Grace",
        }),
      )
    })
    expect(focus).toHaveBeenCalledTimes(1)
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
          replyingTo: "Ada",
        }),
      )
    })
    expect(focus).toHaveBeenCalledTimes(2)

    const view = renderer.root.findByType("controller-probe").props.view
    focus.mockClear()
    await act(async () => view.onDrop({ type: "drop" }))
    expect(handleDropRaw).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith()
    expect(handleDropRaw.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0],
    )

    focus.mockClear()
    view.onAttachOpenChange(true)
    expect(focus).not.toHaveBeenCalled()
    view.onAttachOpenChange(false)
    expect(focus).toHaveBeenCalledWith()

    focus.mockClear()
    view.onUploadFile()
    expect(filePickerClick).toHaveBeenCalled()
    expect(focus).toHaveBeenCalledWith()
    expect(filePickerClick.mock.invocationCallOrder.at(-1)).toBeLessThan(
      focus.mock.invocationCallOrder.at(-1),
    )

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

    channelRefPopupRef.current = { items: [{}], command: vi.fn() }
    expect(editorOptions.editorProps.handleKeyDown({} as never, key())).toBe(
      false,
    )
    expect(accept).not.toHaveBeenCalled()
    channelRefPopupRef.current = { items: [], command: vi.fn() }
    expect(
      editorOptions.editorProps.handleKeyDown(
        {} as never,
        key({ shiftKey: true }),
      ),
    ).toBe(false)
    expect(
      editorOptions.editorProps.handleKeyDown(
        {} as never,
        key({ isComposing: true }),
      ),
    ).toBe(false)
    expect(accept).not.toHaveBeenCalled()

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

  it("covers null-editor, empty/attachment-only, and stale completion defenses", async () => {
    const nullRef = createRef<ComposerHandle>()
    mocks.useEditor.mockImplementationOnce((options) => {
      editorOptions = options
      return null
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(() => true),
          context: "dm",
          draftKey: undefined,
          ref: nullRef,
        }),
      )
    })
    const initialSend = mocks.refInitialValues.find(
      (value): value is () => void => typeof value === "function",
    )
    expect(initialSend).toBeTypeOf("function")
    initialSend?.()
    expect(nullRef.current?.isEmpty()).toBe(true)
    nullRef.current?.submitNow()
    nullRef.current?.resetAfterSubmit()
    expect(mocks.placeholderConfigure).toHaveBeenLastCalledWith({
      placeholder: "Message general",
    })
    await act(async () => renderer.unmount())

    const accept = vi.fn(() => true)
    const handleRef = createRef<ComposerHandle>()
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(accept),
          draftKey: "",
          ref: handleRef,
        }),
      )
    })
    await act(async () => {
      renderer.update(
        createElement(Harness, {
          ...acceptedProps(accept),
          draftKey: undefined,
          ref: handleRef,
        }),
      )
      editorOptions.onUpdate({ editor })
    })
    expect(mocks.writeDraft).not.toHaveBeenCalled()

    editor.isEmpty = true
    pendingFiles = [{
      file: new File(["x"], "attachment.txt", { type: "text/plain" }),
      thumbnailUrl: null,
      thumbnailBlob: null,
    }]
    handleRef.current?.submitNow()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledWith("", expect.any(Array), "everyone")

    pendingFiles = []
    handleRef.current?.submitNow()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())

    let resolveFiles!: (files: PendingFile[]) => void
    const successGate = new Promise<PendingFile[]>((resolve) => {
      resolveFiles = resolve
    })
    mocks.refs.length = 0
    awaitPendingFiles.mockImplementationOnce(() => successGate)
    const staleSuccessRef = createRef<ComposerHandle>()
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(() => true),
          ref: staleSuccessRef,
        }),
      )
    })
    staleSuccessRef.current?.submitNow()
    const successFlight = mocks.refs.find(
      (ref) => ref.current instanceof Promise,
    )
    expect(successFlight).toBeDefined()
    successFlight!.current = Promise.resolve()
    await act(async () => {
      resolveFiles([])
      await successGate
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => renderer.unmount())

    let rejectFiles!: (error: Error) => void
    const failureGate = new Promise<PendingFile[]>((_resolve, reject) => {
      rejectFiles = reject
    })
    mocks.refs.length = 0
    awaitPendingFiles.mockImplementationOnce(() => failureGate)
    const staleFailureRef = createRef<ComposerHandle>()
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(Harness, {
          ...acceptedProps(() => true),
          ref: staleFailureRef,
        }),
      )
    })
    staleFailureRef.current?.submitNow()
    const failureFlight = mocks.refs.find(
      (ref) => ref.current instanceof Promise,
    )
    expect(failureFlight).toBeDefined()
    failureFlight!.current = Promise.resolve()
    await act(async () => {
      rejectFiles(new Error("stale failure"))
      await failureGate.catch(() => undefined)
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => renderer.unmount())
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
