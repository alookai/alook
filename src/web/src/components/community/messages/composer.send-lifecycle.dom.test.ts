import React, { useLayoutEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { useCommunityRuntime, type CommunityRuntime } from "@/stores/community/runtime"
import { acceptChannelMessage, runAcceptedMessageIntent } from "./message-channel-controller-send"

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
vi.mock("@/hooks/community/mutations", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/hooks/community/mutations")>(),
  sendNonce: () => "nonce_collision",
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

    const renderer = render(React.createElement(Composer, {
      ...baseProps,
      onAcceptSend: initialAccept,
    } satisfies ComposerProps))

    const file = new File(["keep me"], "rejected.txt", { type: "text/plain" })
    pendingFiles = [{ file, thumbnailUrl: null, thumbnailBlob: null }]
    renderer.rerender(React.createElement(Composer, {
      ...baseProps,
      replyingTo: { authorName: "Latest reply", text: "First target" },
      onAcceptSend: rejectLatest,
    } satisfies ComposerProps))

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
    expect(renderer.container.textContent).toContain("rejected.txt")
    expect(renderer.container.textContent).toContain("Latest reply")

    renderer.rerender(React.createElement(Composer, {
      ...baseProps,
      replyingTo: { authorName: "Latest reply", text: "First target" },
      onAcceptSend: acceptedLatest,
    } satisfies ComposerProps))

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

  it("preserves the latest Composer draft when the real acceptor rejects a duplicate nonce", async () => {
    let runtime!: CommunityRuntime
    const messageScope = { kind: "channel" as const, id: "channel_1", serverId: "server_1" }
    const viewer = { id: "viewer", name: "Viewer", avatar: "V" }
    const replyTo = { id: "reply_1", authorName: "Latest reply", text: "Original target" }
    const upload = vi.fn()
    const post = vi.fn()
    const clearReply = vi.fn()
    const runner = vi.fn((nonce: string) => runAcceptedMessageIntent({
      runtime, messageScope, nonce, uploadFileAsync: upload, sendMessageAsync: post,
      channelId: messageScope.id, serverId: messageScope.serverId, viewer,
    }))
    const accept = vi.fn((...[markdown, attachments, mentionType]: Parameters<NonNullable<ComposerProps["onAcceptSend"]>>) => acceptChannelMessage({
      runtime, markdown, attachments, mentionType, messageScope, viewer, replyTo,
      runAcceptedIntent: runner, channelId: messageScope.id, clearReply,
    }))
    function ConnectedComposer() {
      const value = useCommunityRuntime()
      useLayoutEffect(() => { runtime = value }, [value])
      return React.createElement(Composer, {
        channel: "general", context: "channel", members: [], sendContract: "accepted",
        hideAttach: true, hideEmoji: true, replyingTo: replyTo, onAcceptSend: accept,
      } satisfies ComposerProps)
    }
    const createPreview = vi.fn(() => "blob:new-rejected")
    const revokePreview = vi.fn()
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createPreview, revokeObjectURL: revokePreview }))
    const renderer = render(React.createElement(ConnectedComposer))
    try {
      const original = new File(["original"], "original.txt", { type: "text/plain" })
      act(() => expect(runtime.messageStream.actions.accept(messageScope, {
        nonce: "nonce_collision", tempId: "temp_original", message: { type: "chat", content: "original body" },
        localUploads: [{ file: original, previewObjectUrl: "blob:original" }],
      })).toBe(true))
      const originalPayload = runtime.messageStream.actions.getRetryPayload(messageScope, "nonce_collision")
      const file = new File(["keep me"], "rejected.txt", { type: "text/plain" })
      const supplied = new File(["keep supplied"], "supplied.txt", { type: "text/plain" })
      pendingFiles = [
        { file, thumbnailUrl: null, thumbnailBlob: null },
        { file: supplied, thumbnailUrl: "blob:supplied", thumbnailBlob: null },
      ]
      renderer.rerender(React.createElement(ConnectedComposer))
      await act(async () => {
        firstEditorOptions!.editorProps.handleKeyDown({} as never, {
          key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
        } as unknown as KeyboardEvent)
      })
      expect(accept).toHaveReturnedWith(false)
      expect(runtime.messageStream.actions.getRetryPayload(messageScope, "nonce_collision")).toEqual(originalPayload)
      expect(runner).not.toHaveBeenCalled()
      expect(upload).not.toHaveBeenCalled()
      expect(post).not.toHaveBeenCalled()
      expect(clearReply).not.toHaveBeenCalled()
      expect(clearContent).not.toHaveBeenCalled()
      expect(transferPendingFiles).not.toHaveBeenCalled()
      expect(renderer.container.textContent).toContain("rejected.txt")
      expect(renderer.container.textContent).toContain("supplied.txt")
      expect(renderer.container.textContent).toContain("Latest reply")
      expect(mocks.serializeDocument).toHaveReturnedWith("9. latest\n10. draft")
      expect(createPreview).toHaveBeenCalledOnce()
      expect(revokePreview.mock.calls).toEqual([["blob:new-rejected"]])
    } finally { renderer.unmount(); vi.unstubAllGlobals() }
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
    render(React.createElement(Composer, {
      channel: "general",
      context: "channel",
      members: [],
      sendContract: "accepted",
      onAcceptSend: accept,
      draftKey: "server/channel",
    } satisfies ComposerProps))

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
    const renderer = render(React.createElement(Composer, props("server/one")))
    await act(async () => {
      firstEditorOptions!.editorProps.handleKeyDown({} as never, {
        key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
      } as unknown as KeyboardEvent)
      await Promise.resolve()
    })
    renderer.rerender(React.createElement(Composer, props("server/two")))
    renderer.rerender(React.createElement(Composer, props("server/one")))
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
    const renderer = render(React.createElement(Composer, props("server/one")))
    const enter = () => firstEditorOptions!.editorProps.handleKeyDown({} as never, {
      key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
    } as unknown as KeyboardEvent)
    await act(async () => {
      enter()
      await Promise.resolve()
    })
    renderer.rerender(React.createElement(Composer, props("server/two")))
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
    const renderer = render(React.createElement(Composer, {
      channel: "general",
      context: "channel",
      members: [],
      sendContract: "accepted",
      onAcceptSend: accept,
    } satisfies ComposerProps))
    await act(async () => {
      firstEditorOptions!.editorProps.handleKeyDown({} as never, {
        key: "Enter", shiftKey: false, isComposing: false, preventDefault: vi.fn(),
      } as unknown as KeyboardEvent)
      await Promise.resolve()
    })
    renderer.unmount()
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
