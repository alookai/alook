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
  X: (props: Record<string, unknown>) => createElement("x-icon", props),
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

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => typeof child === "string" ? child : textContent(child))
    .join("")
}

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
    showSend: false,
    sendDisabled: true,
    onSend: vi.fn(),
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
    const channelRefPresentation = { status: "ready" as const }
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
            replyingTo: { authorName: "Ada", text: "First target" },
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
            channelRefPresentation,
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
    expect(renderer.root.findByType("channel-popup").props.presentation).toBe(
      channelRefPresentation,
    )
    const renderedText = renderer.root
      .findAll(() => true)
      .flatMap((node) => node.children)
      .filter((child): child is string => typeof child === "string")
      .join(" ")
    expect(renderedText).toContain("Replying to")
    expect(renderedText).toContain("Ada")
    expect(renderedText).toContain("First target")
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
    ).toBe("Add file")
    for (const label of ["Cancel reply", "Remove file", "Add file", "Emoji picker"]) {
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
    expect(renderer.root.findAllByType("dropdown-menu")).toHaveLength(0)
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

  it("opens the file picker directly and honors forum/hide flags", async () => {
    const onUploadFile = vi.fn()
    const onEmojiPick = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          ComposerView,
          baseProps({ onUploadFile, onEmojiPick }),
        ),
      )
    })
    await act(async () =>
      renderer.root.findByProps({
        "data-testid": tid.composerAttach,
      }).props.onClick(),
    )
    await act(async () =>
      renderer.root.findByType("emoji-picker").props.onPick("🌱"),
    )
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

  it("shows the exact same-author reply target as one stripped, whole-row-truncated line", async () => {
    const first = {
      authorName: "Ada",
      text: "**First** target with [docs](https://example.test) " + "x".repeat(320),
    }
    const second = {
      authorName: "Ada",
      text: "_Second_ target",
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ComposerView, baseProps({ replyingTo: first })),
      )
    })

    let preview = renderer.root.findByProps({
      "data-slot": "composer-reply-preview",
    })
    expect(textContent(preview)).toBe(
      "Replying to Ada · First target with docs " + "x".repeat(320),
    )
    expect(preview.props.className).toContain("truncate")
    expect(preview.props.className).toContain("min-w-0")
    expect(preview.parent?.props.className).toContain("items-center")

    await act(async () => {
      renderer.update(
        createElement(ComposerView, baseProps({ replyingTo: second })),
      )
    })
    preview = renderer.root.findByProps({
      "data-slot": "composer-reply-preview",
    })
    expect(textContent(preview)).toBe("Replying to Ada · Second target")
  })

  it("renders the explicit send control after emoji with exact eligibility and styling", async () => {
    const onSend = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          ComposerView,
          baseProps({ showSend: true, sendDisabled: true, onSend }),
        ),
      )
    })
    const input = renderer.root.find(
      (node) => node.props["data-testid"] === tid.composerInput,
    )
    expect(input.props.className).toContain("pl-12 pr-24")
    expect(input.props.className).not.toContain("px-12")
    expect(
      renderer.root.findByType("emoji-picker").findByType("button").props
        .className,
    ).toContain("right-12")
    const send = renderer.root.find(
      (node) => node.props["data-testid"] === tid.composerSend,
    )
    expect(send.props).toMatchObject({
      type: "button",
      "aria-label": "Send message",
      disabled: true,
    })
    expect(send.props.className).toContain("right-2")
    expect(send.props.className).toContain("size-8")
    expect(send.props.className).toContain("rounded-[8px]")
    expect(send.props.className).toContain("disabled:bg-transparent")
    expect(send.props.className).toContain("disabled:text-muted-foreground")
    expect(send.props.className).toContain("enabled:hover:bg-primary/90")
    expect(send.props.className).toContain("enabled:active:bg-primary/80")
    expect(send.props.className).not.toContain("rounded-full")
    const icon = send.findByType("svg")
    expect(icon.props).toMatchObject({
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      className: "size-5",
    })
    expect(icon.findByType("path").props).toMatchObject({
      d: "M12.8147 12.1969L5.28344 13.4521C5.10705 13.4815 4.95979 13.6029 4.89723 13.7704L2.29933 20.7278C2.05066 21.3673 2.72008 21.9773 3.33375 21.6705L21.3337 12.6705C21.8865 12.3941 21.8865 11.6052 21.3337 11.3288L3.33375 2.32885C2.72008 2.02201 2.05066 2.63206 2.29933 3.2715L4.89723 10.2289C4.95979 10.3964 5.10705 10.5178 5.28344 10.5472L12.8147 11.8024C12.9236 11.8205 12.9972 11.9236 12.9791 12.0325C12.965 12.1168 12.899 12.1829 12.8147 12.1969Z",
      fill: "currentColor",
    })
    expect(
      renderer.root
        .findAllByType("button")
        .map((node) => node.props["aria-label"])
        .filter(Boolean),
    ).toEqual(["Add file", "Emoji picker", "Send message"])

    await act(async () => {
      renderer.update(
        createElement(
          ComposerView,
          baseProps({ showSend: true, sendDisabled: false, onSend }),
        ),
      )
    })
    const activeSend = renderer.root.find(
      (node) => node.props["data-testid"] === tid.composerSend,
    )
    expect(activeSend.props.disabled).toBe(false)
    expect(activeSend.props.className).toContain("bg-primary")
    expect(activeSend.props.className).toContain("text-primary-foreground")
    await act(async () => {
      activeSend.props.onClick()
    })
    expect(onSend).toHaveBeenCalledOnce()

    await act(async () => {
      renderer.update(createElement(ComposerView, baseProps()))
    })
    expect(
      renderer.root.findAll(
        (node) => node.props["data-testid"] === tid.composerSend,
      ),
    ).toHaveLength(0)
    expect(
      renderer.root.find(
        (node) => node.props["data-testid"] === tid.composerInput,
      ).props.className,
    ).toContain("px-12")
  })

  it("pins the vendored Fluent asset to its exact MIT attribution", () => {
    const license = readFileSync(
      new URL("./FLUENT_SEND_FILLED_LICENSE.md", import.meta.url),
      "utf8",
    )
    expect(license).toContain(
      "4d685f77b2cb8f3f412a74ec8d920c8c91149528/assets/Send/SVG/ic_fluent_send_24_filled.svg",
    )
    expect(license).toContain("Copyright (c) 2020 Microsoft Corporation")
    expect(license).toContain("MIT License")
    expect(license).toContain(
      "The above copyright notice and this permission notice shall be included",
    )
  })

  it("keeps the exact ComposerSkeleton footprint", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ComposerSkeleton))
    })
    const skeletons = renderer.root.findAllByType("skeleton")
    expect(skeletons).toHaveLength(4)
    expect(skeletons.map((node) => node.props.className)).toEqual([
      "h-5 w-2/5 rounded",
      "absolute left-2 bottom-2 size-8 rounded-full",
      "absolute right-12 bottom-2 size-8 rounded-full sm:right-2",
      "absolute right-2 bottom-2 size-8 rounded-full sm:hidden",
    ])
    expect(renderer.toJSON()).toMatchObject({
      type: "div",
      props: { className: "relative px-3 pb-3 pt-0" },
    })
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "relative rounded-xl bg-muted py-3 pl-12 pr-24 shadow-(--e1) ring-1 ring-border/40 sm:px-12",
    )
  })
})
