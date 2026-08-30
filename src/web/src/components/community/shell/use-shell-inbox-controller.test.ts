import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DmCache } from "@/lib/community/dm-cache"
import type { Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { useShellInboxController } from "./use-shell-inbox-controller"

const order: string[] = []
const mocks = vi.hoisted(() => ({
  markedEnabled: [] as boolean[],
  markAll: vi.fn(),
  deleteMention: vi.fn(),
  unmark: vi.fn(),
  verifyDm: vi.fn(),
  armOpener: vi.fn(),
  clearOpener: vi.fn(),
  terminateOpener: vi.fn(),
  begin: vi.fn(),
  submitted: vi.fn(),
  rollback: vi.fn(),
  close: vi.fn(),
  onOpenChange: vi.fn(),
  latestEpoch: 0,
}))

const unreadDm: UnreadDm = {
  channelId: "dm1",
  otherUserId: "u2",
  otherUserName: "Peer",
  otherUserDiscriminator: "2222",
  otherUserAvatar: "P",
  lastMessageAt: "2026-08-24T00:00:00.000Z",
}

const server: UnreadServer = {
  serverId: "s1",
  serverName: "Server",
  channels: [{
    channelId: "c1",
    channelName: "Channel",
    lastMessageAt: "2026-08-24T00:00:00.000Z",
    mentionCount: 0,
    hasDirectUnread: true,
    children: [{
      channelId: "child",
      channelName: "Child",
      lastMessageAt: "2026-08-24T00:00:00.000Z",
      mentionCount: 0,
      parentChannelId: "c1",
      openerMessageId: "opener-7",
      openerSeq: 7,
      openerUnread: true,
    }],
  }],
}

const mention: Mention = {
  id: "m1",
  server: "Server",
  serverId: "s1",
  channel: "Channel",
  channelId: "c1",
  m: { id: "msg1", seq: 4 } as Mention["m"],
}

vi.mock("@/hooks/community/use-inbox", () => ({
  useInboxUnreads: () => ({ servers: [server], dms: [unreadDm], isLoading: false }),
  useInboxMentions: () => ({ mentions: [mention], isLoading: false }),
  useInboxMarked: (enabled: boolean) => {
    mocks.markedEnabled.push(enabled)
    return { marked: [], isLoading: false }
  },
}))
vi.mock("@/hooks/community/use-inbox-auto-collapse", () => ({
  useInboxAutoCollapse: () => ({
    open: true,
    onOpenChange: (...args: unknown[]) => mocks.onOpenChange(...args),
    beginProjection: (...args: unknown[]) => mocks.begin(...args),
    markProjectionSubmitted: (...args: unknown[]) => mocks.submitted(...args),
    rollbackProjection: (...args: unknown[]) => mocks.rollback(...args),
    closeWithoutProjection: (...args: unknown[]) => mocks.close(...args),
    isProjected: () => false,
    isLatestProjection: (epoch: number) => epoch === mocks.latestEpoch,
  }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useMarkAllInboxRead: () => ({ mutate: mocks.markAll }),
  useDeleteMention: () => ({ mutate: mocks.deleteMention }),
  useUnmarkMessage: () => ({ mutate: mocks.unmark }),
}))
vi.mock("@/hooks/community/use-dm-route-verification", () => ({
  startDmRouteVerification: (...args: unknown[]) => mocks.verifyDm(...args),
}))
vi.mock("@/hooks/community/thread-opener-read-handoff", () => ({
  armThreadOpenerReadHandoff: (...args: unknown[]) => mocks.armOpener(...args),
  clearThreadOpenerReadHandoff: (...args: unknown[]) => mocks.clearOpener(...args),
}))
vi.mock("@/hooks/community/inbox-read-reservation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/community/inbox-read-reservation")>()
  return {
    ...original,
    terminateThreadOpenerReservationHandoff: (...args: unknown[]) => mocks.terminateOpener(...args),
  }
})

type Result = ReturnType<typeof useShellInboxController>

function Capture({ options, onResult }: {
  options: Parameters<typeof useShellInboxController>[0]
  onResult: (result: Result) => void
}) {
  onResult(useShellInboxController(options))
  return null
}

async function renderController(
  initialDmCache: DmCache = { conversations: [] },
  push?: (href: string) => void,
) {
  const pushed: string[] = []
  const router = {
    push: (href: string) => {
      order.push("push")
      pushed.push(href)
      push?.(href)
    },
    replace: vi.fn(),
    prefetch: vi.fn(),
  }
  let dmCache = initialDmCache
  const queryClient = {
    setQueryData: vi.fn((_key, updater) => {
      order.push("query")
      dmCache = updater(dmCache)
    }),
  }
  const cancelPendingNavigation = vi.fn(() => { order.push("cancel") })
  let current!: Result
  await act(async () => {
    TestRenderer.create(createElement(Capture, {
      options: {
        router,
        queryClient,
        cancelPendingNavigation,
        publishedHref: "/c/channels/s1",
        navigationPending: false,
        pendingHref: null,
      } as never,
      onResult: (result) => { current = result },
    }))
  })
  return {
    get current() { return current },
    order,
    pushed,
    get dmCache() { return dmCache },
  }
}

describe("useShellInboxController", () => {
  beforeEach(() => {
    order.length = 0
    mocks.markedEnabled.length = 0
    for (const mock of [
      mocks.markAll,
      mocks.deleteMention,
      mocks.unmark,
      mocks.verifyDm,
      mocks.armOpener,
      mocks.clearOpener,
      mocks.terminateOpener,
      mocks.begin,
      mocks.submitted,
      mocks.rollback,
      mocks.close,
      mocks.onOpenChange,
    ]) mock.mockReset()
    mocks.latestEpoch = 0
    mocks.begin.mockImplementation(() => {
      order.push("project")
      mocks.latestEpoch += 1
      return mocks.latestEpoch
    })
    mocks.submitted.mockImplementation((epoch: number) => {
      order.push("submitted")
      return epoch === mocks.latestEpoch
    })
    mocks.rollback.mockImplementation(() => { order.push("rollback"); return true })
    mocks.close.mockImplementation(() => { order.push("close"); return true })
    mocks.onOpenChange.mockImplementation(() => { order.push("reopen") })
    mocks.clearOpener.mockImplementation(() => { order.push("clear") })
    mocks.armOpener.mockImplementation(() => {
      order.push("arm")
      return "/c/channels/s1/child?inboxThreadOpener=nonce-1"
    })
    mocks.verifyDm.mockImplementation(() => {
      order.push("verify")
      return Promise.resolve("present")
    })
  })

  it("keeps Marked lazy and latches it after first selection", async () => {
    const hook = await renderController()
    expect(mocks.markedEnabled.at(-1)).toBe(false)
    await act(async () => hook.current.popoverProps.onMarkedTabSelected?.())
    expect(mocks.markedEnabled.at(-1)).toBe(true)
  })

  it("closes/projects before cancel and pushes a direct channel without data work", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      true,
    ))
    expect(order).toEqual(["project", "cancel", "clear", "push", "submitted"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1"])
  })

  it("opens a structural-only parent without projecting any unread", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      false,
    ))
    expect(order).toEqual(["close", "cancel", "clear", "push"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1"])
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("reopens a structural-only parent surface when navigation throws", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    order.length = 0
    await expect(act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      false,
    ))).rejects.toThrow("push failed")
    expect(order).toEqual(["close", "cancel", "clear", "push", "cancel", "reopen"])
    expect(mocks.onOpenChange).toHaveBeenCalledWith(true)
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("upserts a DM only after projection/cancel and verifies only after push", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm))
    expect(order).toEqual([
      "project",
      "cancel",
      "clear",
      "query",
      "push",
      "submitted",
      "verify",
    ])
    expect(hook.dmCache.conversations[0]?.id).toBe("dm1")
  })

  it("arms an exact unread opener after stale setup is cleared and before push", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenThread?.(
      server,
      server.channels[0]!,
      server.channels[0]!.children[0]!,
    ))
    expect(order).toEqual(["project", "cancel", "clear", "arm", "push", "submitted"])
    expect(hook.pushed).toEqual(["/c/channels/s1/child?inboxThreadOpener=nonce-1"])
  })

  it("leaves an invalid Mention completely untouched", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMention?.({ id: "bad" } as Mention))
    expect(order).toEqual([])
  })

  it("projects a valid Mention and submits its channel synchronously", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMention?.(mention))
    expect(order).toEqual(["project", "cancel", "clear", "push", "submitted"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1"])
  })

  it("closes Marked without creating a projection", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk1",
      serverId: "s1",
      channelId: "c1",
      m: { seq: 7 },
    } as never))
    expect(order).toEqual(["close", "cancel", "clear", "push"])
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("rolls back and reopens the latest projection when push throws", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    order.length = 0
    await expect(act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      true,
    ))).rejects.toThrow("push failed")
    expect(order).toEqual([
      "project",
      "cancel",
      "clear",
      "push",
      "cancel",
      "rollback",
    ])
    expect(mocks.rollback).toHaveBeenCalledWith(1, true)
  })

  it("terminates only the exact thread handoff and never verifies a failed DM push", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    await expect(act(async () => hook.current.popoverProps.onOpenThread?.(
      server,
      server.channels[0]!,
      server.channels[0]!.children[0]!,
    ))).rejects.toThrow("push failed")
    expect(mocks.terminateOpener).toHaveBeenCalledWith(expect.anything(), "nonce-1")

    order.length = 0
    await expect(act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm)))
      .rejects.toThrow("push failed")
    expect(mocks.verifyDm).not.toHaveBeenCalled()
  })

  it("lets re-entrant B keep ownership when stale A throws afterward", async () => {
    const serverB: UnreadServer = {
      ...server,
      channels: [{
        ...server.channels[0]!,
        channelId: "c2",
        channelName: "Channel B",
        children: [],
      }],
    }
    const holder: { hook?: Awaited<ReturnType<typeof renderController>> } = {}
    const hook = await renderController(undefined, (href) => {
      if (href !== "/c/channels/s1/c1") return
      holder.hook!.current.popoverProps.onOpenChannel?.(
        serverB,
        serverB.channels[0]!,
        true,
      )
      throw new Error("stale A failed")
    })
    holder.hook = hook
    order.length = 0

    await expect(act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      true,
    ))).rejects.toThrow("stale A failed")

    expect(hook.pushed).toEqual([
      "/c/channels/s1/c1",
      "/c/channels/s1/c2",
    ])
    expect(mocks.latestEpoch).toBe(2)
    expect(mocks.rollback).not.toHaveBeenCalled()
    expect(order.filter((item) => item === "cancel")).toHaveLength(2)
  })

  it("wires mark/delete/unmark payloads", async () => {
    const hook = await renderController()
    await act(async () => hook.current.popoverProps.onMarkAllRead?.())
    await act(async () => hook.current.popoverProps.onDeleteMention?.("mn1"))
    await act(async () => hook.current.popoverProps.onUnmark?.("msg1"))
    expect(mocks.markAll).toHaveBeenCalledWith()
    expect(mocks.deleteMention).toHaveBeenCalledWith({ mentionId: "mn1" })
    expect(mocks.unmark).toHaveBeenCalledWith({ messageId: "msg1" })
  })
})
