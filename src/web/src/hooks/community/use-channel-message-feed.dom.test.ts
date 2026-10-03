import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { useChannelMessageFeed } from "./use-channel-message-feed"

const mocks = vi.hoisted(() => ({
  readState: {
    snapshot: {
      lastReadMessageId: "authoritative-anchor" as string | null,
      lastReadSeq: 2,
    } as { lastReadMessageId: string | null; lastReadSeq: number } | null,
    isFetching: false,
    error: null as unknown,
    retry: vi.fn(),
  },
  messages: {
    messages: [
      { id: "self", authorId: "viewer" },
      { id: "authoritative-anchor", authorId: "viewer" },
      { id: "peer", authorId: "peer" },
    ],
    anchorReconciled: true,
    latestSeq: 5,
    isPending: false,
    isError: false,
    hasMoreNewer: false,
    refetch: vi.fn(),
    error: null as unknown,
  },
  useMessages: vi.fn(),
  watermark: vi.fn(),
  canonicalReadSnapshot: undefined as undefined | {
    lastReadMessageId: string | null
    lastReadAt: string
    lastReadSeq: number
  },
}))

vi.mock("./use-channel-read-state", () => ({
  useChannelReadStateSnapshot: () => mocks.readState,
}))
vi.mock("./use-messages", () => ({
  useMessages: (...args: unknown[]) => {
    mocks.useMessages(...args)
    return mocks.messages
  },
}))
vi.mock("./use-channel-watermark", () => ({
  useChannelWatermark: (input: unknown) => mocks.watermark(input),
}))
vi.mock("./use-channel-panels", () => ({
  useThreads: () => ({ threads: [], isLoading: false }),
  usePins: () => ({ pins: [], isLoading: false }),
}))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useReadStateProjection: () => mocks.canonicalReadSnapshot,
}))

function Capture({ onResult }: { onResult?: (result: ReturnType<typeof useChannelMessageFeed>) => void }) {
  const result = useChannelMessageFeed({
    channelId: "channel",
    serverId: "server",
    viewerUserId: "viewer",
    isChildChannel: false,
    anchorMessageId: null,
  })
  onResult?.(result)
  return createElement("output", {
    "data-divider": result.newDividerBefore,
    "data-anchor-found": result.anchorInCache,
    "data-unread": result.unreadCount,
  })
}

describe("useChannelMessageFeed", () => {
  beforeEach(() => {
    mocks.readState.snapshot = {
      lastReadMessageId: "authoritative-anchor",
      lastReadSeq: 2,
    }
    mocks.readState.isFetching = false
    mocks.readState.error = null
    mocks.readState.retry.mockReset()
    mocks.messages.error = null
    mocks.messages.refetch.mockReset()
    mocks.messages.messages = [
      { id: "self", authorId: "viewer" },
      { id: "authoritative-anchor", authorId: "viewer" },
      { id: "peer", authorId: "peer" },
    ]
    mocks.messages.anchorReconciled = true
    mocks.useMessages.mockReset()
    mocks.watermark.mockReset()
    mocks.canonicalReadSnapshot = undefined
  })

  it("always revalidates a mount and reconciles the authoritative server anchor", () => {
    const renderer = render(createElement(Capture))
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: "authoritative-anchor",
      waitForAnchor: true,
      reconcileLateAnchor: true,
      revalidateOnMount: true,
    }))
    expect(renderer.container.querySelector("output")).toHaveAttribute("data-divider", "peer")
    expect(renderer.container.querySelector("output")).toHaveAttribute("data-unread", "3")
    renderer.unmount()
  })

  it("prioritizes a definitive message denial over a simultaneous transient read failure", () => {
    const denied = Object.assign(new Error("Forbidden"), { status: 403 })
    mocks.readState.error = new Error("Read unavailable")
    mocks.messages.error = denied
    let latest!: ReturnType<typeof useChannelMessageFeed>
    render(createElement(Capture, { onResult: (result) => { latest = result } }))
    expect(latest.initialLoadError).toBe(denied)
    act(() => latest.retryInitialLoad())
    expect(mocks.messages.refetch).toHaveBeenCalledWith({ cancelRefetch: false })
    expect(mocks.readState.retry).not.toHaveBeenCalled()
  })

  it("retries a read snapshot failure without refetching usable cached messages", () => {
    const failure = new Error("Read snapshot unavailable")
    mocks.readState.error = failure
    let latest!: ReturnType<typeof useChannelMessageFeed>
    render(createElement(Capture, { onResult: (result) => { latest = result } }))
    expect(latest.initialLoadError).toBe(failure)
    expect(latest.messages).toEqual(mocks.messages.messages)
    act(() => latest.retryInitialLoad())
    expect(mocks.readState.retry).toHaveBeenCalledOnce()
    expect(mocks.messages.refetch).not.toHaveBeenCalled()
  })

  it("seeds the frozen mount snapshot from the canonical read projection", () => {
    mocks.canonicalReadSnapshot = {
      lastReadMessageId: "authoritative-anchor",
      lastReadAt: "2026-09-26T00:00:00.000Z",
      lastReadSeq: 2,
    }
    render(createElement(Capture)).unmount()
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: "authoritative-anchor",
    }))
  })

  it("projects a warm canonical anchor before the query page marker settles", () => {
    mocks.messages.anchorReconciled = false
    const renderer = render(createElement(Capture))
    const output = renderer.container.querySelector("output")!
    expect(output).toHaveAttribute("data-divider", "peer")
    expect(output).toHaveAttribute("data-anchor-found", "true")
    renderer.unmount()
  })

  it("keeps an incomplete canonical window unresolved until its anchor arrives", () => {
    mocks.messages.anchorReconciled = false
    mocks.messages.messages = [{ id: "peer", authorId: "peer" }]
    const renderer = render(createElement(Capture))
    const output = () => renderer.container.querySelector("output")!
    expect(output()).not.toHaveAttribute("data-divider")
    expect(output()).toHaveAttribute("data-anchor-found", "false")

    mocks.messages.messages = [
      { id: "authoritative-anchor", authorId: "viewer" },
      { id: "peer", authorId: "peer" },
    ]
    renderer.rerender(createElement(Capture))
    expect(output()).toHaveAttribute("data-divider", "peer")
    expect(output()).toHaveAttribute("data-anchor-found", "true")
    renderer.unmount()
  })

  it("gates the messages request until the mount-owned server anchor resolves", () => {
    mocks.readState.snapshot = null
    mocks.readState.isFetching = true
    const renderer = render(createElement(Capture))
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: undefined,
      waitForAnchor: true,
      reconcileLateAnchor: true,
      revalidateOnMount: true,
    }))

    mocks.readState.snapshot = {
      lastReadMessageId: "resolved-anchor",
      lastReadSeq: 7,
    }
    mocks.readState.isFetching = false
    renderer.rerender(createElement(Capture))
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: "resolved-anchor",
      waitForAnchor: true,
    }))
    renderer.unmount()
  })
})
