import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DmCache } from "@/lib/community/dm-cache"
import { useShellInboxController } from "./use-shell-inbox-controller"

const mocks = vi.hoisted(() => ({
  markedEnabled: [] as boolean[],
  watch: vi.fn(),
  markAll: vi.fn(),
  deleteMention: vi.fn(),
  unmark: vi.fn(),
  readForum: vi.fn(),
  verifyDm: vi.fn(),
}))

const unreadDm = {
  channelId: "dm1",
  otherUserId: "u2",
  otherUserName: "Peer",
  otherUserDiscriminator: "2222",
  otherUserAvatar: "P",
  lastMessageAt: "2026-08-24T00:00:00.000Z",
}

vi.mock("@/hooks/community/use-inbox", () => ({
  useInboxUnreads: () => ({
    servers: [],
    dms: [unreadDm],
    isLoading: false,
  }),
  useInboxMentions: () => ({ mentions: [], isLoading: false }),
  useInboxMarked: (enabled: boolean) => {
    mocks.markedEnabled.push(enabled)
    return { marked: [], isLoading: false }
  },
}))
vi.mock("@/hooks/community/use-inbox-auto-collapse", () => ({
  useInboxAutoCollapse: () => ({ open: true, onOpenChange: vi.fn(), watchItem: mocks.watch }),
}))
vi.mock("@/hooks/community/mutations", () => ({
  useMarkAllInboxRead: () => ({ mutate: mocks.markAll }),
  useDeleteMention: () => ({ mutate: mocks.deleteMention }),
  useUnmarkMessage: () => ({ mutate: mocks.unmark }),
  useReadForumThreadFromInbox: () => ({ mutate: mocks.readForum }),
}))
vi.mock("@/hooks/community/use-dm-route-verification", () => ({
  startDmRouteVerification: (...args: unknown[]) => mocks.verifyDm(...args),
}))

type Result = ReturnType<typeof useShellInboxController>

function Capture({ options, onResult }: {
  options: Parameters<typeof useShellInboxController>[0]
  onResult: (result: Result) => void
}) {
  onResult(useShellInboxController(options))
  return null
}

async function renderController(initialDmCache: DmCache = { conversations: [{
  id: "dm2",
  userId: "u3",
  name: "Other",
  discriminator: "3333",
  avatar: "O",
  status: "offline" as const,
  preview: "",
  unread: true,
}] }) {
  const order: string[] = []
  const pushed: string[] = []
  const router = {
    push: (href: string) => { order.push("push"); pushed.push(href) },
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
  mocks.watch.mockImplementation(() => { order.push("watch") })
  mocks.readForum.mockImplementation(() => { order.push("read") })
  mocks.verifyDm.mockImplementation(() => {
    order.push("verify")
    return Promise.resolve("present")
  })
  let current!: Result
  let renderer!: TestRenderer.ReactTestRenderer
  const options = { router, queryClient, cancelPendingNavigation } as never
  await act(async () => {
    renderer = TestRenderer.create(createElement(Capture, {
      options,
      onResult: (result) => { current = result },
    }))
  })
  return {
    get current() { return current },
    renderer,
    order,
    pushed,
    get dmCache() { return dmCache },
  }
}

describe("useShellInboxController", () => {
  beforeEach(() => {
    mocks.markedEnabled.length = 0
    for (const mock of [mocks.watch, mocks.markAll, mocks.deleteMention, mocks.unmark, mocks.readForum, mocks.verifyDm]) {
      mock.mockReset()
    }
  })

  it("keeps Marked lazy and latches it after first selection", async () => {
    const hook = await renderController()
    expect(mocks.markedEnabled.at(-1)).toBe(false)
    await act(async () => hook.current.popoverProps.onMarkedTabSelected?.())
    expect(mocks.markedEnabled.at(-1)).toBe(true)
    await act(async () => hook.current.popoverProps.onMarkedTabSelected?.())
    expect(mocks.markedEnabled.at(-1)).toBe(true)
  })

  it("provisionally upserts a missing DM before push and starts background verification", async () => {
    const hook = await renderController()
    hook.order.length = 0
    await act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm))
    expect(hook.order).toEqual(["query", "watch", "cancel", "push", "verify"])
    expect(mocks.watch).toHaveBeenCalledWith("dm:dm1")
    expect(hook.pushed).toEqual(["/c/me/dm1"])
    expect(hook.dmCache.conversations[0]).toEqual({
      id: "dm1",
      userId: "u2",
      name: "Peer",
      discriminator: "2222",
      avatar: "P",
      status: "offline",
      preview: "",
      unread: false,
    })
    expect(hook.dmCache.conversations[1]?.id).toBe("dm2")
    expect(mocks.verifyDm).toHaveBeenCalledWith(expect.anything(), "dm1")
  })

  it("preserves an existing canonical preview and presence when verification fails transiently", async () => {
    const canonical = {
      id: "dm1",
      userId: "u2",
      name: "Peer",
      discriminator: "2222",
      avatar: "P",
      status: "online" as const,
      preview: "canonical preview",
      unread: true,
    }
    const hook = await renderController({ conversations: [canonical] })
    mocks.verifyDm.mockRejectedValueOnce(new Error("offline"))

    await act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm))

    expect(hook.dmCache.conversations).toEqual([{
      ...canonical,
      unread: false,
    }])
  })

  it("preserves forum and mention watch keys and non-blocking routes", async () => {
    const hook = await renderController()
    hook.order.length = 0
    await act(async () => hook.current.popoverProps.onOpenForumThread("s1", "forum", "child", "opener"))
    expect(hook.order).toEqual(["watch", "read", "cancel", "push"])
    expect(mocks.watch).toHaveBeenCalledWith("channel:child")
    expect(mocks.readForum).toHaveBeenCalledWith({ parentChannelId: "forum", openerMessageId: "opener" })
    expect(hook.pushed.at(-1)).toBe("/c/channels/s1/child")

    hook.order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMention?.({ id: "m1" } as never))
    expect(hook.order).toEqual([])
    await act(async () => hook.current.popoverProps.onOpenMention?.({ id: "m1", serverId: "s1", channelId: "c1" } as never))
    expect(mocks.watch).toHaveBeenLastCalledWith("mention:m1")
    expect(hook.pushed.at(-1)).toBe("/c/channels/s1/c1")
  })

  it("routes marked rows by server/DM with optional seq and exact watch keys", async () => {
    const hook = await renderController()
    await act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk1",
      serverId: "s1",
      channelId: "c1",
      m: { seq: 7 },
    } as never))
    expect(mocks.watch).toHaveBeenLastCalledWith("marked:mk1")
    expect(hook.pushed.at(-1)).toBe("/c/channels/s1/c1?seq=7")

    await act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk-child",
      serverId: "s1",
      channelId: "child1",
      parentChannelId: "parent1",
      m: { seq: 8 },
    } as never))
    expect(mocks.watch).toHaveBeenLastCalledWith("marked:mk-child")
    expect(hook.pushed.at(-1)).toBe("/c/channels/s1/child1?seq=8")

    await act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk2",
      serverId: null,
      channelId: "dm1",
      m: {},
    } as never))
    expect(mocks.watch).toHaveBeenLastCalledWith("marked:mk2")
    expect(hook.pushed.at(-1)).toBe("/c/me/dm1")
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
