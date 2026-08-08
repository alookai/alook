import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  useEditor: vi.fn(),
  useFileAttachments: vi.fn(),
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
  EMPTY_MENTION_STATE: { items: [], selectedIndex: 0, command: null, rect: null },
  rankMentionItems: vi.fn(() => []),
}))

vi.mock("@/lib/community/channel-ref-extension", () => ({
  buildCommunityChannelRefExtension: vi.fn(() => ({})),
  EMPTY_CHANNEL_REF_STATE: { items: [], selectedIndex: 0, command: null, rect: null },
  rankChannelRefItems: vi.fn(() => []),
  toChannelRefCommandProps: vi.fn(),
}))

vi.mock("@/hooks/use-file-attachments", () => ({
  useFileAttachments: (...args: unknown[]) => mocks.useFileAttachments(...args),
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

  beforeEach(() => {
    firstEditorOptions = undefined
    mocks.useEditor.mockReset()
    mocks.useFileAttachments.mockReset()
    pendingFiles = []
    clearContent = vi.fn()
    transferPendingFiles = vi.fn(() => pendingFiles)

    const editor = {
      isEmpty: false,
      getText: vi.fn(() => "latest draft"),
      getJSON: vi.fn(() => ({})),
      commands: {
        clearContent,
        focus: vi.fn(),
        setContent: vi.fn(),
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
        replyingTo: "Latest reply",
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
      "latest draft",
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
        replyingTo: "Latest reply",
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
      "latest draft",
      [{ file, previewObjectUrl: undefined, width: undefined, height: undefined }],
      undefined,
    )
    expect(clearContent).toHaveBeenCalledOnce()
    expect(transferPendingFiles).toHaveBeenCalledOnce()
  })
})
