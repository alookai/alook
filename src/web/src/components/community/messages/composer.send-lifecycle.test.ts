import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useEditor: vi.fn(),
  useFileAttachments: vi.fn(),
  composerDocumentExtensions: vi.fn(),
  preservePlainTextPaste: vi.fn(),
  serializeDocument: vi.fn(),
}))

vi.mock("@tiptap/react", () => ({
  useEditor: (...args: unknown[]) => mocks.useEditor(...args),
  EditorContent: () => null,
}))

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: vi.fn(() => ({})) },
}))

vi.mock("@tiptap/extension-placeholder", () => ({
  default: { configure: vi.fn(() => ({})) },
}))

vi.mock("@tiptap/pm/model", () => ({
  DOMParser: { fromSchema: vi.fn() },
}))

vi.mock("@/lib/community/mention-extension", () => ({
  buildCommunityMentionExtension: vi.fn(() => ({})),
  detectMentionType: vi.fn(() => undefined),
  EMPTY_MENTION_STATE: { items: [], selectedIndex: 0, command: null, getRect: null },
  rankMentionItems: vi.fn(() => []),
}))

vi.mock("@/lib/community/channel-ref-extension", () => ({
  buildCommunityChannelRefExtension: vi.fn(() => ({})),
  EMPTY_CHANNEL_REF_STATE: { items: [], selectedIndex: 0, command: null, getRect: null },
  rankChannelRefItems: vi.fn(() => []),
  toChannelRefCommandProps: vi.fn(),
}))

vi.mock("@/hooks/use-file-attachments", () => ({
  useFileAttachments: (...args: unknown[]) => mocks.useFileAttachments(...args),
}))

vi.mock("@/hooks/use-hover-capable", () => ({
  useHoverCapable: () => true,
}))

vi.mock("./composer-ordered-list", () => ({
  composerDocumentExtensions: (...args: unknown[]) =>
    mocks.composerDocumentExtensions(...args),
  preserveComposerPlainTextPaste: (...args: unknown[]) =>
    mocks.preservePlainTextPaste(...args),
  serializeComposerDocument: (...args: unknown[]) =>
    mocks.serializeDocument(...args),
}))

import { Composer, type ComposerProps } from "./composer"
import type { PendingFile } from "@/hooks/use-file-attachments"

describe("Composer committed send lifecycle", () => {
  let firstEditorOptions: {
    editorProps: {
      handleKeyDown: (_view: unknown, event: KeyboardEvent) => boolean
    }
  } | undefined
  let pendingFiles: PendingFile[]
  let clearContent: ReturnType<typeof vi.fn>
  let transferPendingFiles: ReturnType<typeof vi.fn>
  let awaitPendingFiles: ReturnType<typeof vi.fn>

  beforeEach(() => {
    firstEditorOptions = undefined
    mocks.useEditor.mockReset()
    mocks.useFileAttachments.mockReset()
    mocks.composerDocumentExtensions.mockReturnValue([{ name: "document-extensions" }])
    mocks.preservePlainTextPaste.mockReturnValue(true)
    mocks.serializeDocument.mockReturnValue("9. latest\n10. draft")
    pendingFiles = []
    clearContent = vi.fn()
    transferPendingFiles = vi.fn(() => pendingFiles)
    awaitPendingFiles = vi.fn(async () => pendingFiles)

    const editor = {
      isEmpty: false,
      getText: vi.fn(() => "latest draft"),
      getJSON: vi.fn(() => ({})),
      commands: {
        clearContent,
        focus: vi.fn(),
        liftEmptyBlock: vi.fn(() => false),
        setContent: vi.fn(),
        splitListItem: vi.fn(() => false),
      },
      chain: vi.fn(() => ({
        focus: vi.fn(() => ({
          insertContent: vi.fn(() => ({ run: vi.fn() })),
        })),
      })),
    }

    mocks.useEditor.mockImplementation((options) => {
      firstEditorOptions ??= options
      return editor
    })
    mocks.useFileAttachments.mockImplementation(() => ({
      pendingFiles,
      setPendingFiles: vi.fn(),
      transferPendingFiles,
      restorePendingFiles: vi.fn(),
      awaitPendingFiles,
      addPendingFiles: vi.fn(),
      fileInputRef: { current: null },
      handleFileSelect: vi.fn(),
      removePendingFile: vi.fn(),
      dragging: false,
      handleDragEnter: vi.fn(),
      handleDragLeave: vi.fn(),
      handleDragOver: vi.fn(),
      handleDrop: vi.fn(),
    }))
  })

  it("routes the initially registered Enter handler through the latest attachments and callback", async () => {
    const initialAccept = vi.fn(() => true)
    const rejectedContexts: string[] = []
    const rejectLatest = vi.fn(() => {
      rejectedContexts.push("Latest reply")
      return false
    })
    const acceptedLatest = vi.fn(() => true)
    const baseProps = {
      channel: "general",
      context: "channel" as const,
      members: [],
      sendContract: "accepted" as const,
      hideAttach: true,
      hideEmoji: true,
    }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Composer, {
        ...baseProps,
        onAcceptSend: initialAccept,
      } satisfies ComposerProps))
    })

    const file = new File(["keep me"], "rejected.txt", { type: "text/plain" })
    pendingFiles = [{ file, thumbnailUrl: null, thumbnailBlob: null }]
    await act(async () => {
      renderer.update(React.createElement(Composer, {
        ...baseProps,
        replyingTo: { authorName: "Latest reply", text: "First target" },
        onAcceptSend: rejectLatest,
      } satisfies ComposerProps))
    })

    const preventRejected = vi.fn()
    await act(async () => {
      expect(firstEditorOptions!.editorProps.handleKeyDown({} as never, {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: preventRejected,
      } as unknown as KeyboardEvent)).toBe(true)
    })

    expect(preventRejected).toHaveBeenCalledOnce()
    expect(initialAccept).not.toHaveBeenCalled()
    expect(rejectLatest).toHaveBeenCalledWith(
      "9. latest\n10. draft",
      [{ file, previewObjectUrl: undefined, width: undefined, height: undefined }],
      undefined,
    )
    expect(rejectedContexts).toEqual(["Latest reply"])
    expect(clearContent).not.toHaveBeenCalled()
    expect(transferPendingFiles).not.toHaveBeenCalled()
    expect(JSON.stringify(renderer.toJSON())).toContain("rejected.txt")
    expect(JSON.stringify(renderer.toJSON())).toContain("Latest reply")

    await act(async () => {
      renderer.update(React.createElement(Composer, {
        ...baseProps,
        replyingTo: { authorName: "Latest reply", text: "First target" },
        onAcceptSend: acceptedLatest,
      } satisfies ComposerProps))
    })

    await act(async () => {
      firstEditorOptions!.editorProps.handleKeyDown({} as never, {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent)
    })

    expect(acceptedLatest).toHaveBeenCalledWith(
      "9. latest\n10. draft",
      [{ file, previewObjectUrl: undefined, width: undefined, height: undefined }],
      undefined,
    )
    expect(clearContent).toHaveBeenCalledOnce()
    expect(transferPendingFiles).toHaveBeenCalledOnce()
  })

  it("waits for same-tick file preparation and sends once with the exact thumbnail Blob", async () => {
    let releasePreparation!: () => void
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve })
    const file = new File(["original"], "photo.png", { type: "image/png" })
    const thumbnailBlob = new Blob(["thumbnail"], { type: "image/jpeg" })
    const prepared = [{
      file,
      thumbnailUrl: "blob:thumbnail",
      thumbnailBlob,
      width: 640,
      height: 480,
    }]
    awaitPendingFiles.mockImplementationOnce(async () => {
      await preparation
      pendingFiles = prepared
      return prepared
    })
    const accept = vi.fn(() => true)
    await act(async () => {
      TestRenderer.create(React.createElement(Composer, {
        channel: "general",
        context: "channel",
        members: [],
        sendContract: "accepted",
        onAcceptSend: accept,
        draftKey: "server/channel",
      } satisfies ComposerProps))
    })

    const immediateEnter = () => firstEditorOptions!.editorProps.handleKeyDown({} as never, {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent)
    await act(async () => {
      expect(immediateEnter()).toBe(true)
      expect(immediateEnter()).toBe(true)
      await Promise.resolve()
    })
    expect(accept).not.toHaveBeenCalled()

    await act(async () => {
      releasePreparation()
      await preparation
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledWith("9. latest\n10. draft", [{
      file,
      thumbnailBlob,
      previewObjectUrl: "blob:thumbnail",
      width: 640,
      height: 480,
    }], undefined)
    expect(accept.mock.calls[0][1]?.[0].thumbnailBlob).toBe(thumbnailBlob)
    expect(clearContent).toHaveBeenCalledOnce()
    expect(transferPendingFiles).toHaveBeenCalledOnce()
  })

  it("cancels a pending send across an A → B → A scope cycle", async () => {
    let releasePreparation!: () => void
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve })
    const file = new File(["original"], "photo.png", { type: "image/png" })
    awaitPendingFiles.mockImplementationOnce(async () => {
      await preparation
      return [{ file, thumbnailUrl: null, thumbnailBlob: null }]
    })
    const accept = vi.fn(() => true)
    const props = (draftKey: string) => ({
      channel: draftKey,
      context: "channel" as const,
      members: [],
      sendContract: "accepted" as const,
      onAcceptSend: accept,
      draftKey,
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Composer, props("server/one")))
    })
    await act(async () => {
      firstEditorOptions!.editorProps.handleKeyDown({} as never, {
        key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
      } as unknown as KeyboardEvent)
      await Promise.resolve()
    })
    await act(async () => {
      renderer.update(React.createElement(Composer, props("server/two")))
    })
    await act(async () => {
      renderer.update(React.createElement(Composer, props("server/one")))
    })
    await act(async () => {
      releasePreparation()
      await preparation
      await Promise.resolve()
    })

    expect(accept).not.toHaveBeenCalled()
    expect(clearContent).not.toHaveBeenCalled()
    expect(transferPendingFiles).not.toHaveBeenCalled()
  })

  it("does not route an old pending file into a new scope without a fresh Enter", async () => {
    let releaseOld!: () => void
    const oldPreparation = new Promise<void>((resolve) => { releaseOld = resolve })
    const oldFile = new File(["old"], "old.png", { type: "image/png" })
    awaitPendingFiles.mockImplementationOnce(async () => {
      await oldPreparation
      pendingFiles = [{ file: oldFile, thumbnailUrl: null, thumbnailBlob: null }]
      return pendingFiles
    })
    const accept = vi.fn(() => true)
    const props = (draftKey: string) => ({
      channel: draftKey,
      context: "channel" as const,
      members: [],
      sendContract: "accepted" as const,
      onAcceptSend: accept,
      draftKey,
    })
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Composer, props("server/one")))
    })
    const enter = () => firstEditorOptions!.editorProps.handleKeyDown({} as never, {
      key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
    } as unknown as KeyboardEvent)
    await act(async () => {
      enter()
      await Promise.resolve()
    })
    await act(async () => {
      renderer.update(React.createElement(Composer, props("server/two")))
    })
    await act(async () => {
      enter()
      await Promise.resolve()
    })
    expect(accept).not.toHaveBeenCalled()
    await act(async () => {
      releaseOld()
      await oldPreparation
      await Promise.resolve()
    })
    expect(accept).not.toHaveBeenCalled()
    await act(async () => {
      enter()
      await Promise.resolve()
    })
    expect(accept).toHaveBeenCalledOnce()
    expect(accept.mock.calls[0][1]).toEqual([expect.objectContaining({ file: oldFile })])
  })

  it("cancels a pending send before layout unmount completes", async () => {
    let releasePreparation!: () => void
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve })
    const file = new File(["old"], "old.png", { type: "image/png" })
    awaitPendingFiles.mockImplementationOnce(async () => {
      await preparation
      return [{ file, thumbnailUrl: null, thumbnailBlob: null }]
    })
    const accept = vi.fn(() => true)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Composer, {
        channel: "general",
        context: "channel",
        members: [],
        sendContract: "accepted",
        onAcceptSend: accept,
      } satisfies ComposerProps))
    })
    await act(async () => {
      firstEditorOptions!.editorProps.handleKeyDown({} as never, {
        key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
      } as unknown as KeyboardEvent)
      await Promise.resolve()
    })
    act(() => renderer.unmount())
    await act(async () => {
      releasePreparation()
      await preparation
      await Promise.resolve()
    })

    expect(accept).not.toHaveBeenCalled()
    expect(clearContent).not.toHaveBeenCalled()
    expect(transferPendingFiles).not.toHaveBeenCalled()
  })
})
