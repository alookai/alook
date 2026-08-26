import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { Friend } from "@/lib/community/models/people"

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }))

vi.mock("sonner", () => ({ toast: toastSpy }))

import { InviteFriendRow, runInviteFriend } from "./invite-dialog"

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

describe("runInviteFriend", () => {
  beforeEach(() => {
    toastSpy.mockClear()
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
    expect(toastSpy).not.toHaveBeenCalled()
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
    expect(toastSpy).toHaveBeenCalledWith("network down")

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
