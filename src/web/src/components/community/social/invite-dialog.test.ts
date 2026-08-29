import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { Friend } from "@/lib/community/models/people"

const mocks = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  onlineUserIds: new Set<string>(),
  onlineFriendIds: [] as string[],
  friendsQuery: {
    friends: [] as Friend[],
    data: { friends: [] as Friend[] } as { friends: Friend[] } | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
}))

vi.mock("sonner", () => ({ toast: mocks.toastSpy }))
vi.mock("@/stores/community/ws", () => ({
  useOnlineUserIds: () => mocks.onlineUserIds,
}))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriendsPresence: () => ({ online: mocks.onlineFriendIds }),
}))
vi.mock("@/hooks/community/use-invitable-friends", () => ({
  useInvitableFriends: () => mocks.friendsQuery,
}))
vi.mock("@/hooks/community/mutations", () => ({
  useResolveOrCreateInvite: () => () => Promise.resolve({ token: "token" }),
  useCreateOrGetDm: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock("@/hooks/community/use-dm-message-sender", () => ({
  useDmMessageSender: () => ({ accept: vi.fn() }),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer", name: "Viewer", avatar: "V" }),
}))
vi.mock("@/components/ui/dialog", async () => {
  const { createElement } = await import("react")
  return {
    Dialog: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children),
    DialogContent: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children),
  }
})
vi.mock("../people-picker", async () => {
  const { createElement } = await import("react")
  return {
    PeoplePickerBody: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children),
    PeoplePickerHeader: ({ title }: { title: string }) => createElement("h1", null, title),
    PeoplePickerRowsSkeleton: () => createElement("div"),
    resolvePeoplePickerViewState: () => "ready",
  }
})

import { InviteDialog, InviteFriendRow, runInviteFriend } from "./invite-dialog"

const friend: Friend = {
  id: "friend_1",
  userId: "user_1",
  name: "Alice",
  discriminator: "0001",
  avatar: "A",
  status: "online",
  sub: "@Alice#0001",
}

function renderRow({
  tokenReady = true,
  inviting = false,
  invited = false,
}: {
  tokenReady?: boolean
  inviting?: boolean
  invited?: boolean
} = {}) {
  return renderToStaticMarkup(
    createElement(InviteFriendRow, {
      friend,
      tokenReady,
      inviting,
      invited,
      onInvite: () => {},
    }),
  )
}

function hasDisabledButton(html: string) {
  return /<button[^>]*\sdisabled(?:=""|>)/.test(html)
}

function trackingSetter() {
  let current = new Set<string>()
  const snapshots: string[][] = []
  const setter = (next: Set<string> | ((value: Set<string>) => Set<string>)) => {
    current = typeof next === "function" ? next(current) : next
    snapshots.push([...current].sort())
  }
  return {
    setter: setter as never,
    snapshots,
    current: () => [...current].sort(),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("InviteFriendRow", () => {
  it("shows Invite while idle", () => {
    const html = renderRow()
    expect(html).toContain(">Invite<")
    expect(html).not.toContain("animate-spin")
    expect(hasDisabledButton(html)).toBe(false)
  })

  it("shows a spinner and disables only the in-flight row", () => {
    const html = renderRow({ inviting: true })
    expect(html).toContain("Sending invite")
    expect(html).toContain("animate-spin")
    expect(hasDisabledButton(html)).toBe(true)
    expect(html).not.toContain(">Invite<")
  })

  it("shows Invited and stays disabled after success", () => {
    const html = renderRow({ invited: true })
    expect(html).toContain(">Invited<")
    expect(hasDisabledButton(html)).toBe(true)
  })

  it("keeps loading rows on the real row padding and trailing action footprint", () => {
    const source = readFileSync(new URL("./invite-dialog.tsx", import.meta.url), "utf8")
    expect(source).toContain('<div data-slot="invite-friends-loading">')
    expect(source).toContain('<PeoplePickerRowsSkeleton secondaryLine actionClassName="w-16" />')
  })

  it("distinguishes unresolved and failed candidate data from a resolved empty list", () => {
    const source = readFileSync(new URL("./invite-dialog.tsx", import.meta.url), "utf8")
    expect(source).toContain("resolved: friendsQuery.data !== undefined")
    expect(source).toContain("error: friendsQuery.isError")
    expect(source).toContain("friendsQuery.data === undefined && friendsQuery.isFetching")
    expect(source).toContain("void friendsQuery.refetch()")
  })
})

describe("InviteDialog presence", () => {
  beforeEach(() => {
    mocks.onlineUserIds = new Set()
    mocks.onlineFriendIds = []
    mocks.friendsQuery.friends = []
    mocks.friendsQuery.data = { friends: [] }
  })

  function renderDialog() {
    return renderToStaticMarkup(createElement(InviteDialog, {
      open: true,
      onOpenChange: () => {},
      serverId: "server_1",
      serverName: "Alook",
    }))
  }

  it("overlays canonical live presence onto an offline API friend row", () => {
    mocks.onlineUserIds = new Set([friend.userId!])
    mocks.friendsQuery.friends = [{ ...friend, status: "offline" }]
    mocks.friendsQuery.data = { friends: mocks.friendsQuery.friends }

    expect(renderDialog()).toContain('data-presence="online"')
  })

  it("keeps a friend offline when the canonical live set does not contain them", () => {
    mocks.friendsQuery.friends = [{ ...friend, status: "online" }]
    mocks.friendsQuery.data = { friends: mocks.friendsQuery.friends }

    expect(renderDialog()).toContain('data-presence="offline"')
  })

  it("keeps the friend online when reconnect friends refresh wins before server hydration", () => {
    const serverMemberId = "server_member"
    mocks.onlineFriendIds = [friend.userId!]
    mocks.friendsQuery.friends = [{ ...friend, status: "offline" }]
    mocks.friendsQuery.data = { friends: mocks.friendsQuery.friends }

    // Deterministic reconnect order: reset → friends refresh contains the
    // non-member friend → later server hydrate replaces the WS scope.
    mocks.onlineUserIds = new Set()
    mocks.onlineUserIds = new Set([serverMemberId])
    expect(renderDialog()).toContain('data-presence="online"')

    // An exact offline delta patches both sources, so the union does not mask
    // the transition with the older friends snapshot.
    mocks.onlineUserIds = new Set([serverMemberId])
    mocks.onlineFriendIds = []
    expect(renderDialog()).toContain('data-presence="offline"')
  })
})

describe("runInviteFriend", () => {
  beforeEach(() => {
    mocks.toastSpy.mockClear()
  })

  it("covers the complete success lifecycle", async () => {
    const inFlight = new Set<string>()
    const state = trackingSetter()
    const onInvited = vi.fn()

    await expect(
      runInviteFriend("user_1", inFlight, async () => {}, onInvited, state.setter),
    ).resolves.toBe(true)

    expect(state.snapshots).toEqual([["user_1"], []])
    expect(onInvited).toHaveBeenCalledWith("user_1")
    expect(mocks.toastSpy).not.toHaveBeenCalled()
  })

  it("clears the row and allows retry after failure", async () => {
    const inFlight = new Set<string>()
    const state = trackingSetter()
    const sendInvite = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined)

    await expect(
      runInviteFriend("user_1", inFlight, sendInvite, vi.fn(), state.setter),
    ).resolves.toBe(false)
    expect(inFlight).not.toContain("user_1")
    expect(state.current()).toEqual([])
    expect(mocks.toastSpy).toHaveBeenCalledWith("network down")

    await expect(
      runInviteFriend("user_1", inFlight, sendInvite, vi.fn(), state.setter),
    ).resolves.toBe(true)
    expect(sendInvite).toHaveBeenCalledTimes(2)
  })

  it("collapses rapid duplicate activation into one send chain", async () => {
    const gate = deferred()
    const inFlight = new Set<string>()
    const state = trackingSetter()
    const sendInvite = vi.fn(() => gate.promise)
    const onInvited = vi.fn()

    const first = runInviteFriend(
      "user_1",
      inFlight,
      sendInvite,
      onInvited,
      state.setter,
    )
    const duplicate = runInviteFriend(
      "user_1",
      inFlight,
      sendInvite,
      onInvited,
      state.setter,
    )

    await expect(duplicate).resolves.toBe(false)
    expect(sendInvite).toHaveBeenCalledTimes(1)
    gate.resolve()
    await expect(first).resolves.toBe(true)
    expect(onInvited).toHaveBeenCalledTimes(1)
  })

  it("keeps different friend rows independent", async () => {
    const firstGate = deferred()
    const inFlight = new Set<string>()
    const state = trackingSetter()
    const first = runInviteFriend(
      "user_1",
      inFlight,
      () => firstGate.promise,
      vi.fn(),
      state.setter,
    )

    await expect(
      runInviteFriend("user_2", inFlight, async () => {}, vi.fn(), state.setter),
    ).resolves.toBe(true)
    expect(inFlight).toEqual(new Set(["user_1"]))

    firstGate.resolve()
    await first
    expect(inFlight).toEqual(new Set())
  })
})
