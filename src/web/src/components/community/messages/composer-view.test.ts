import { createElement } from "react"
import { readFileSync } from "node:fs"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@tiptap/react", () => ({
  EditorContent: (props: Record<string, unknown>) =>
    createElement("editor-content", props),
}))
vi.mock("lucide-react", () => ({
  FileIcon: (props: Record<string, unknown>) => createElement("file-icon", props),
  ImageIcon: (props: Record<string, unknown>) =>
    createElement("image-icon", props),
  PlusCircle: (props: Record<string, unknown>) =>
    createElement("plus-icon", props),
  Smile: (props: Record<string, unknown>) => createElement("smile-icon", props),
  Upload: (props: Record<string, unknown>) =>
    createElement("upload-icon", props),
  X: (props: Record<string, unknown>) => createElement("x-icon", props),
}))
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: Record<string, unknown>) =>
    createElement("dropdown-menu", props),
  DropdownMenuTrigger: (props: Record<string, unknown>) =>
    createElement(
      "dropdown-trigger",
      props,
      props.render as never,
      props.children as never,
    ),
  DropdownMenuContent: (props: Record<string, unknown>) =>
    createElement("dropdown-content", props),
  DropdownMenuItem: (props: Record<string, unknown>) =>
    createElement("dropdown-item", props),
}))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("skeleton", props),
}))
vi.mock("./emoji-picker", () => ({
  EmojiPickerPopover: (props: Record<string, unknown>) =>
    createElement("emoji-picker", props),
}))
vi.mock("./composer-suggestion-popups", () => ({
  CommunityMentionList: (props: Record<string, unknown>) =>
    createElement("mention-popup", props),
  ChannelRefList: (props: Record<string, unknown>) =>
    createElement("channel-popup", props),
}))

import {
  ComposerSkeleton,
  ComposerView,
  type ComposerViewProps,
} from "./composer-view"
import type { PendingFile } from "@/hooks/use-file-attachments"
import {
  EMPTY_CHANNEL_REF_STATE,
} from "@/lib/community/channel-ref-extension"
import { EMPTY_MENTION_STATE } from "@/lib/community/mention-extension"
import { tid } from "@/lib/community/testids"

function baseProps(
  overrides: Partial<ComposerViewProps> = {},
): ComposerViewProps {
  return {
    isForumThreadBody: false,
    dragging: false,
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    mentionPopup: EMPTY_MENTION_STATE,
    mentionPresentation: { status: "ready" },
    channelRefPopup: EMPTY_CHANNEL_REF_STATE,
    pendingFiles: [],
    removePendingFile: vi.fn(),
    fileInputRef: { current: null },
    onFileSelect: vi.fn(),
    editor: null,
    hideAttach: false,
    hideEmoji: false,
    onAttachOpenChange: vi.fn(),
    onUploadFile: vi.fn(),
    onEmojiPick: vi.fn(),
    ...overrides,
  }
}

describe("ComposerView", () => {
  it("scopes single-line placeholder containment to chat composers", () => {
    const css = readFileSync(
      new URL("../../../app/globals.css", import.meta.url),
      "utf8",
    )
    const globalRule = css.match(
      /\.tiptap p\.is-editor-empty:first-child::before\s*\{([^}]*)\}/,
    )?.[1]
    const chatRule = css.match(
      /\.chat-composer \.tiptap p\.is-editor-empty:first-child::before\s*\{([^}]*)\}/,
    )?.[1]
    expect(globalRule).toBeDefined()
    expect(globalRule).not.toContain("text-overflow")
    expect(globalRule).not.toContain("white-space")
    expect(chatRule).toContain("position: absolute")
    expect(chatRule).toContain("overflow: hidden")
    expect(chatRule).toContain("text-overflow: ellipsis")
    expect(chatRule).toContain("white-space: nowrap")
  })

  it("keeps popup, reply, icon-only pending, drag, editor, and control order", async () => {
    const removePendingFile = vi.fn()
    const onCancelReply = vi.fn()
    const onFileSelect = vi.fn()
    const onDragEnter = vi.fn()
    const onDragLeave = vi.fn()
    const onDragOver = vi.fn()
    const onDrop = vi.fn()
    const mentionPopup = {
      ...EMPTY_MENTION_STATE,
      items: [{ kind: "everyone" as const, id: "everyone", label: "everyone" }],
    }
    const channelRefPopup = {
      ...EMPTY_CHANNEL_REF_STATE,
      items: [
        {
          id: "channel-1",
          name: "general",
          serverId: "server-1",
          serverName: "One",
          serverDiscriminator: "0001",
        },
      ],
    }
    const image = new File(["image"], "photo.png", { type: "image/png" })
    const textFile = new File(["text"], "notes.txt", { type: "text/plain" })
    const pendingFiles = [
      { file: image, thumbnailUrl: "blob:image", width: 640, height: 480 },
      { file: textFile, thumbnailUrl: null, thumbnailBlob: null },
    ] as PendingFile[]
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          ComposerView,
          baseProps({
            replyingTo: "Ada",
            onCancelReply,
            pendingFiles,
            removePendingFile,
            dragging: true,
            onFileSelect,
            onDragEnter,
            onDragLeave,
            onDragOver,
            onDrop,
            mentionPopup,
            channelRefPopup,
          }),
        ),
      )
    })

    const root = renderer.toJSON() as TestRenderer.ReactTestRendererJSON
    const topTypes = (root.children ?? [])
      .filter((child): child is TestRenderer.ReactTestRendererJSON =>
        typeof child === "object" && child !== null,
      )
      .map((child) => child.type)
    expect(topTypes.slice(0, 2)).toEqual(["mention-popup", "channel-popup"])
    expect(renderer.root.findByType("mention-popup").props.state).toBe(
      mentionPopup,
    )
    expect(renderer.root.findByType("channel-popup").props.state).toBe(
      channelRefPopup,
    )
    const renderedText = renderer.root
      .findAll(() => true)
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === "string")
      .join(" ")
    expect(renderedText).toContain("Replying to")
    expect(renderedText).toContain("Ada")
    expect(renderedText).toContain("photo.png")
    expect(renderedText).toContain("notes.txt")
    expect(renderedText).toContain("Drop files here")
    expect(renderer.root.findAllByType("image-icon")).toHaveLength(1)
    expect(renderer.root.findAllByType("file-icon")).toHaveLength(1)
    expect(renderer.root.findAllByType("img")).toHaveLength(0)

    const hostRoot = renderer.root.findAllByType("div")[0]
    const dragEvent = { type: "drag" }
    await act(async () => {
      hostRoot.props.onDragEnter(dragEvent)
      hostRoot.props.onDragLeave(dragEvent)
      hostRoot.props.onDragOver(dragEvent)
      hostRoot.props.onDrop(dragEvent)
    })
    expect(onDragEnter).toHaveBeenCalledWith(dragEvent)
    expect(onDragLeave).toHaveBeenCalledWith(dragEvent)
    expect(onDragOver).toHaveBeenCalledWith(dragEvent)
    expect(onDrop).toHaveBeenCalledWith(dragEvent)

    await act(async () =>
      renderer.root
        .find(
          (node) =>
            node.type === "button" &&
            node.props["aria-label"] === "Cancel reply",
        )
        .props.onClick(),
    )
    expect(onCancelReply).toHaveBeenCalledOnce()

    const removeButtons = renderer.root.findAll(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Remove file",
    )
    await act(async () => removeButtons[1].props.onClick())
    expect(removePendingFile).toHaveBeenCalledWith(1)
    const input = renderer.root.findByType("input")
    expect(input.props).toMatchObject({
      type: "file",
      multiple: true,
      className: "hidden",
    })
    const changeEvent = { target: { files: [] } }
    await act(async () => input.props.onChange(changeEvent))
    expect(onFileSelect).toHaveBeenCalledWith(changeEvent)
    expect(
      renderer.root.find(
        (node) => node.props["data-testid"] === tid.composerInput,
      ).props.className,
    ).toContain("px-12")
    expect(
      renderer.root.find(
        (node) => node.props["data-testid"] === tid.composerAttach,
      ).props["aria-label"],
    ).toBe("Add")
    for (const label of ["Cancel reply", "Remove file", "Add", "Emoji picker"]) {
      expect(
        renderer.root.findAll(
          (node) => node.type === "button" && node.props["aria-label"] === label,
        ).length,
        label,
      ).toBeGreaterThan(0)
    }
    expect(
      renderer.root.find(
        (node) =>
          node.type === "div" &&
          node.props.className?.includes("focus-within:ring-2"),
      ).props.className,
    ).toContain("rounded-b-xl")
    expect(
      renderer.root.find(
        (node) =>
          node.type === "div" && node.props.className?.includes("flex-wrap"),
      ).props.className,
    ).not.toContain("rounded-t-xl")
    expect(renderer.root.findAllByType("dropdown-menu")).toHaveLength(1)
    expect(renderer.root.findAllByType("emoji-picker")).toHaveLength(1)

    await act(async () => {
      renderer.update(
        createElement(
          ComposerView,
          baseProps({ pendingFiles, removePendingFile }),
        ),
      )
    })
    expect(
      renderer.root.find(
        (node) =>
          node.type === "div" && node.props.className?.includes("flex-wrap"),
      ).props.className,
    ).toContain("rounded-t-xl border-t")
  })

  it("forwards only event wiring and honors forum/hide flags", async () => {
    const onAttachOpenChange = vi.fn()
    const onUploadFile = vi.fn()
    const onEmojiPick = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          ComposerView,
          baseProps({ onAttachOpenChange, onUploadFile, onEmojiPick }),
        ),
      )
    })
    await act(async () =>
      renderer.root.findByType("dropdown-menu").props.onOpenChange(false),
    )
    await act(async () =>
      renderer.root.findByType("dropdown-item").props.onClick(),
    )
    await act(async () =>
      renderer.root.findByType("emoji-picker").props.onPick("🌱"),
    )
    expect(onAttachOpenChange).toHaveBeenCalledWith(false)
    expect(onUploadFile).toHaveBeenCalledOnce()
    expect(onEmojiPick).toHaveBeenCalledWith("🌱")
    expect(
      renderer.root.find(
        (node) =>
          node.type === "div" &&
          node.props.className?.includes("focus-within:ring-2"),
      ).props.className,
    ).toContain("rounded-xl")

    await act(async () => {
      renderer.update(
        createElement(
          ComposerView,
          baseProps({
            isForumThreadBody: true,
            hideAttach: true,
            hideEmoji: true,
          }),
        ),
      )
    })
    expect(renderer.root.findAllByType("dropdown-menu")).toHaveLength(0)
    expect(renderer.root.findAllByType("emoji-picker")).toHaveLength(0)
    expect(renderer.root.findAllByType("div")[0].props.className).toBe(
      "relative",
    )
    expect(
      renderer.root.find(
        (node) => node.props["data-testid"] === tid.composerInput,
      ).props.className,
    ).toContain("px-2")
    expect(renderer.root.findByType("editor-content").props.className).toContain(
      "max-h-60",
    )
  })

  it("keeps the exact ComposerSkeleton footprint", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ComposerSkeleton))
    })
    const skeletons = renderer.root.findAllByType("skeleton")
    expect(skeletons).toHaveLength(3)
    expect(skeletons.map((node) => node.props.className)).toEqual([
      "h-5 w-2/5 rounded",
      "absolute left-2 bottom-2 size-8 rounded-full",
      "absolute right-2 bottom-2 size-8 rounded-full",
    ])
    expect(renderer.toJSON()).toMatchObject({
      type: "div",
      props: { className: "relative px-3 pb-3 pt-0" },
    })
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "relative rounded-xl bg-muted px-12 py-3 shadow-(--e1) ring-1 ring-border/40",
    )
  })
})
