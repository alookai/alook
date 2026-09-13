import { createElement, type ReactNode } from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  mentionProps: vi.fn(),
  channelProps: vi.fn(),
  emojiProps: vi.fn(),
}))

vi.mock("@tiptap/react", () => ({
  EditorContent: (props: Record<string, unknown>) =>
    createElement("div", { ...props, "data-editor-content": "" }),
}))
vi.mock("lucide-react", () => ({
  FileIcon: (props: Record<string, unknown>) => createElement("span", { ...props, "data-file-icon": "" }),
  ImageIcon: (props: Record<string, unknown>) =>
    createElement("span", { ...props, "data-image-icon": "" }),
  PlusCircle: (props: Record<string, unknown>) =>
    createElement("span", { ...props, "data-plus-icon": "" }),
  Smile: (props: Record<string, unknown>) => createElement("span", { ...props, "data-smile-icon": "" }),
  X: (props: Record<string, unknown>) => createElement("span", { ...props, "data-x-icon": "" }),
}))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("div", { ...props, "data-skeleton": "" }),
}))
vi.mock("./emoji-picker", () => ({
  EmojiPickerPopover: (props: Record<string, unknown>) => {
    mocks.emojiProps(props)
    return createElement("div", { "data-emoji-picker": "" }, props.children as ReactNode)
  },
}))
vi.mock("./composer-suggestion-popups", () => ({
  CommunityMentionList: (props: Record<string, unknown>) => {
    mocks.mentionProps(props)
    return createElement("div", { "data-mention-popup": "" })
  },
  ChannelRefList: (props: Record<string, unknown>) => {
    mocks.channelProps(props)
    return createElement("div", { "data-channel-popup": "" })
  },
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
      resolve(
        process.cwd(),
        process.cwd().endsWith("/src/web") ? "" : "src/web",
        "src/app/globals.css",
      ),
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
    const renderer = render(createElement(
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
    ))

    const topTypes = [...renderer.container.firstElementChild!.children]
      .map((child) => child.hasAttribute("data-mention-popup")
        ? "mention-popup"
        : child.hasAttribute("data-channel-popup") ? "channel-popup" : child.tagName)
    expect(topTypes.slice(0, 2)).toEqual(["mention-popup", "channel-popup"])
    expect(mocks.mentionProps.mock.calls.at(-1)?.[0].state).toBe(mentionPopup)
    expect(mocks.channelProps.mock.calls.at(-1)?.[0].state).toBe(channelRefPopup)
    expect(mocks.channelProps.mock.calls.at(-1)?.[0].presentation).toBe(channelRefPresentation)
    const renderedText = renderer.container.textContent ?? ""
    expect(renderedText).toContain("Replying to")
    expect(renderedText).toContain("Ada")
    expect(renderedText).toContain("First target")
    expect(renderedText).toContain("photo.png")
    expect(renderedText).toContain("notes.txt")
    expect(renderedText).toContain("Drop files here")
    expect(renderer.container.querySelectorAll("[data-image-icon]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-file-icon]")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("img")).toHaveLength(0)

    const hostRoot = renderer.container.firstElementChild!
    fireEvent.dragEnter(hostRoot)
    fireEvent.dragLeave(hostRoot)
    fireEvent.dragOver(hostRoot)
    fireEvent.drop(hostRoot)
    expect(onDragEnter).toHaveBeenCalledOnce()
    expect(onDragLeave).toHaveBeenCalledOnce()
    expect(onDragOver).toHaveBeenCalledOnce()
    expect(onDrop).toHaveBeenCalledOnce()

    fireEvent.click(renderer.container.querySelector('[aria-label="Cancel reply"]')!)
    expect(onCancelReply).toHaveBeenCalledOnce()

    const removeButtons = renderer.container.querySelectorAll('[aria-label="Remove file"]')
    fireEvent.click(removeButtons[1]!)
    expect(removePendingFile).toHaveBeenCalledWith(1)
    const input = renderer.container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.multiple).toBe(true)
    expect(input.className).toBe("hidden")
    fireEvent.change(input)
    expect(onFileSelect).toHaveBeenCalledOnce()
    expect(
      renderer.container.querySelector(`[data-testid="${tid.composerInput}"]`)?.className,
    ).toContain("px-12")
    expect(
      renderer.container.querySelector(`[data-testid="${tid.composerAttach}"]`)
        ?.getAttribute("aria-label"),
    ).toBe("Add file")
    for (const label of ["Cancel reply", "Remove file", "Add file", "Emoji picker"]) {
      expect(
        renderer.container.querySelectorAll(`button[aria-label="${label}"]`).length,
        label,
      ).toBeGreaterThan(0)
    }
    expect(
      renderer.container.querySelector('[class*="focus-within:ring-2"]')?.className,
    ).toContain("rounded-b-xl")
    expect(
      renderer.container.querySelector('[class*="flex-wrap"]')?.className,
    ).not.toContain("rounded-t-xl")
    expect(renderer.container.querySelectorAll("dropdown-menu")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-emoji-picker]")).toHaveLength(1)

    renderer.rerender(createElement(
      ComposerView,
      baseProps({ pendingFiles, removePendingFile }),
    ))
    expect(
      renderer.container.querySelector('[class*="flex-wrap"]')?.className,
    ).toContain("rounded-t-xl border-t")
  })

  it("opens the file picker directly and honors forum/hide flags", async () => {
    const onUploadFile = vi.fn()
    const onEmojiPick = vi.fn()
    const renderer = render(createElement(
      ComposerView,
      baseProps({ onUploadFile, onEmojiPick }),
    ))
    fireEvent.click(renderer.container.querySelector(
      `[data-testid="${tid.composerAttach}"]`,
    )!)
    ;(mocks.emojiProps.mock.calls.at(-1)?.[0].onPick as (emoji: string) => void)("🌱")
    expect(onUploadFile).toHaveBeenCalledOnce()
    expect(onEmojiPick).toHaveBeenCalledWith("🌱")
    expect(
      renderer.container.querySelector('[class*="focus-within:ring-2"]')?.className,
    ).toContain("rounded-xl")

    renderer.rerender(createElement(
      ComposerView,
      baseProps({
        isForumThreadBody: true,
        hideAttach: true,
        hideEmoji: true,
      }),
    ))
    expect(renderer.container.querySelectorAll("dropdown-menu")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-emoji-picker]")).toHaveLength(0)
    expect(renderer.container.firstElementChild?.className).toBe("relative")
    expect(
      renderer.container.querySelector(`[data-testid="${tid.composerInput}"]`)?.className,
    ).toContain("px-2")
    expect(renderer.container.querySelector("[data-editor-content]")?.className).toContain(
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
    const renderer = render(
      createElement(ComposerView, baseProps({ replyingTo: first })),
    )

    let preview = renderer.container.querySelector('[data-slot="composer-reply-preview"]')!
    expect(preview.textContent).toBe(
      "Replying to Ada · First target with docs " + "x".repeat(320),
    )
    expect(preview.className).toContain("truncate")
    expect(preview.className).toContain("min-w-0")
    expect(preview.parentElement?.className).toContain("items-center")

    renderer.rerender(
      createElement(ComposerView, baseProps({ replyingTo: second })),
    )
    preview = renderer.container.querySelector('[data-slot="composer-reply-preview"]')!
    expect(preview.textContent).toBe("Replying to Ada · Second target")
  })

  it("renders only the send control on the right for touch chat", async () => {
    const onSend = vi.fn()
    const renderer = render(createElement(
      ComposerView,
      baseProps({ showSend: true, sendDisabled: true, onSend }),
    ))
    const input = renderer.container.querySelector(`[data-testid="${tid.composerInput}"]`)!
    expect(input.className).toContain("px-12")
    expect(input.parentElement?.className).toContain("rounded-[24px]")
    expect(renderer.container.querySelector("[data-emoji-picker]")).toBeNull()
    const send = renderer.container.querySelector<HTMLButtonElement>(
      `[data-testid="${tid.composerSend}"]`,
    )!
    expect(send.type).toBe("button")
    expect(send.getAttribute("aria-label")).toBe("Send message")
    expect(send.disabled).toBe(true)
    expect(send.className).toContain("right-2")
    expect(send.className).toContain("size-8")
    expect(send.className).toContain("rounded-full")
    expect(send.className).toContain("disabled:bg-transparent")
    expect(send.className).toContain("disabled:text-muted-foreground")
    expect(send.className).toContain("enabled:hover:bg-primary/90")
    expect(send.className).toContain("enabled:active:bg-primary/80")
    const icon = send.querySelector("svg")!
    expect(icon.getAttribute("viewBox")).toBe("0 0 24 24")
    expect(icon.getAttribute("aria-hidden")).toBe("true")
    expect(icon.getAttribute("class")).toBe(
      "size-5 -translate-x-px translate-y-px",
    )
    expect(icon.getAttribute("fill")).toBe("none")
    expect(icon.getAttribute("stroke")).toBe("currentColor")
    expect(icon.getAttribute("stroke-width")).toBe("2")
    expect(icon.getAttribute("stroke-linecap")).toBe("round")
    expect(icon.getAttribute("stroke-linejoin")).toBe("round")
    expect(icon.querySelectorAll("path")).toHaveLength(2)
    expect(
      [...renderer.container.querySelectorAll("button")]
        .map((node) => node.getAttribute("aria-label"))
        .filter(Boolean),
    ).toEqual(["Add file", "Send message"])

    renderer.rerender(createElement(
      ComposerView,
      baseProps({ showSend: true, sendDisabled: false, onSend }),
    ))
    const activeSend = renderer.container.querySelector<HTMLButtonElement>(
      `[data-testid="${tid.composerSend}"]`,
    )!
    expect(activeSend.disabled).toBe(false)
    expect(activeSend.className).toContain("bg-primary")
    expect(activeSend.className).toContain("text-primary-foreground")
    fireEvent.click(activeSend)
    expect(onSend).toHaveBeenCalledOnce()

    renderer.rerender(createElement(ComposerView, baseProps()))
    expect(renderer.container.querySelectorAll(`[data-testid="${tid.composerSend}"]`))
      .toHaveLength(0)
    expect(
      renderer.container.querySelector(`[data-testid="${tid.composerInput}"]`)?.className,
    ).toContain("px-12")
  })

  it("keeps the exact ComposerSkeleton footprint", async () => {
    const renderer = render(createElement(ComposerSkeleton))
    const skeletons = renderer.container.querySelectorAll("[data-skeleton]")
    expect(skeletons).toHaveLength(3)
    expect([...skeletons].map((node) => node.className)).toEqual([
      "h-6 w-2/5 rounded",
      "absolute left-2 bottom-2 size-8 rounded-full",
      "absolute right-2 bottom-2 size-8 rounded-full",
    ])
    expect(renderer.container.firstElementChild?.tagName).toBe("DIV")
    expect(renderer.container.firstElementChild?.className).toBe(
      "relative pl-[max(0.75rem,var(--app-safe-area-left))] pr-[max(0.75rem,var(--app-safe-area-right))] pb-[calc(0.75rem+var(--app-safe-area-bottom))] pt-0 sm:px-3 sm:pb-3",
    )
    expect(renderer.container.innerHTML).toContain(
      "relative rounded-xl [@media(hover:none)]:rounded-[24px] bg-muted py-3 px-12 shadow-(--e1) ring-1 ring-border/40",
    )
  })
})
