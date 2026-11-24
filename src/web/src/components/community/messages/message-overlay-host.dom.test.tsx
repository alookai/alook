import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, screen, waitFor } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import type { Msg } from "@/lib/community/models/message"
import { MessageList } from "./message-list"
import { tid } from "@/lib/community/testids"

const markedHookCalls = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/community/use-inbox", () => ({
  useMessageMarked: (messageId: string, enabled: boolean) => {
    markedHookCalls(messageId, enabled)
    return { data: { marked: false } }
  },
}))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalCommunityProfile: () => ({ userId: "u1", name: "Alice", discriminator: "", avatar: "A", avatarVersion: 0 }),
}))
vi.mock("./emoji-picker-interactive", async () => {
  const ReactModule = await import("react")
  return { default: ({ onPick }: { onPick: (emoji: string) => void }) =>
    ReactModule.createElement("button", { onClick: () => onPick("🎉") }, "Pick celebration") }
})

function makeMessages(count: number): Msg[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    seq: index + 1,
    type: "chat",
    authorId: "u1",
    authorName: "Alice",
    content: `Plain message ${index}`,
    createdAt: new Date(index * 60_000).toISOString(),
  }))
}

describe("MessageList shared overlay host", () => {
  beforeEach(() => {
    markedHookCalls.mockClear()
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} })
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("mounts zero per-row menus or mark observers on idle rows and keeps at most one hover toolbar", async () => {
    const onCopy = vi.fn()
    const onMark = vi.fn()
    const onReply = vi.fn()
    const view = renderCommunity(
      <MessageList
        channel="general"
        messages={makeMessages(30)}
        onOpenThread={() => {}}
        onCopy={onCopy}
        onMark={onMark}
        onReply={onReply}
      />,
    )

    expect(view.container.querySelectorAll('[data-slot="context-menu-trigger"]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-slot="dropdown-menu-trigger"]')).toHaveLength(0)
    expect(view.queryAllByRole("button", { name: "More actions" })).toHaveLength(0)
    expect(markedHookCalls).not.toHaveBeenCalled()

    const row0 = view.getByTestId(tid.message("m0")).querySelector<HTMLElement>("[data-page-swipe-reply-row]")!
    const row1 = view.getByTestId(tid.message("m1")).querySelector<HTMLElement>("[data-page-swipe-reply-row]")!

    fireEvent.pointerEnter(row0, { pointerType: "mouse" })
    expect(view.queryAllByRole("button", { name: "More actions" })).toHaveLength(1)
    expect(markedHookCalls).not.toHaveBeenCalled()

    fireEvent.pointerLeave(row0, { pointerType: "mouse" })
    fireEvent.pointerEnter(row1, { pointerType: "mouse" })
    expect(view.queryAllByRole("button", { name: "More actions" })).toHaveLength(1)

    fireEvent.pointerLeave(row1, { pointerType: "mouse" })
    expect(view.queryAllByRole("button", { name: "More actions" })).toHaveLength(0)

    fireEvent.contextMenu(row1, { button: 2, clientX: 120, clientY: 160 })
    await waitFor(() => expect(screen.getByRole("menu")).toBeVisible())
    expect(markedHookCalls).toHaveBeenCalledWith("m1", true)
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Text" }))
    expect(onCopy).toHaveBeenCalledWith("m1", undefined)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())

    // Touch tap opens the single shared touch menu
    const body0 = view.getByTestId(tid.message("m0")).querySelector<HTMLElement>("[data-community-message-body]")!
    fireEvent.pointerDown(body0, { pointerType: "touch", pointerId: 7, button: 0, clientX: 100, clientY: 180 })
    fireEvent.touchStart(body0)
    fireEvent.touchEnd(body0)
    fireEvent.click(body0, { button: 0, clientX: 100, clientY: 180 })
    await waitFor(() => expect(document.querySelector("[data-message-touch-menu][data-open]")).not.toBeNull())
    expect(screen.getByRole("menuitem", { name: "Reply" })).toBeVisible()
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }))
    expect(onReply).toHaveBeenCalledWith("m0")

    view.unmount()
  })
})
