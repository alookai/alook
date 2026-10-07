import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { channelMembershipKey } from "@/lib/community-db/schema"
import type { ChannelMember } from "@/hooks/community/use-channel-members"
import { useChannelMemberViewModel } from "./channel-member-view-model"

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), toastError: vi.fn() }))
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/client")>(),
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: mocks.toastError }) }))

beforeEach(() => {
  mocks.apiFetch.mockReset()
  mocks.toastError.mockReset()
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const parentMembers: ChannelMember[] = ["viewer", "bob", "carol"].map((userId) => ({
  id: `member_${userId}`, userId,
  name: userId === "viewer" ? "Viewer" : userId === "bob" ? "Bob" : "Carol",
  discriminator: "0042", avatar: userId, avatarVersion: 0, sub: "",
  role: userId === "viewer" ? "owner" : "member", status: "offline",
  statusEmoji: null, statusText: "", source: userId === "viewer" ? "admin" : "explicit",
  isCreator: userId === "viewer",
}))

function Harness({ channelId = "thread" }: { channelId?: string }) {
  const model = useChannelMemberViewModel({
    serverId: "server", channelId, channelName: channelId,
    currentServer: { categories: [{ channels: [
      { id: "parent", type: "text" }, { id: "thread", type: "thread" }, { id: "other", type: "thread" },
    ] }] },
    channelInServer: { creatorId: "viewer" },
    currentChannelMeta: { name: channelId, parentChannelId: "parent", creatorId: "viewer" },
    isChildChannel: true, isNotifyUnit: true, currentUser: { id: "viewer" },
  })
  return <>
    <button onClick={() => model.memberPanelProps.onAddMember?.()}>Open picker</button>
    {model.manageMembersDialog}
  </>
}

async function fixture() {
  const owner = await createCommunityQueryOwner()
  const roster = new Map<string, Set<string>>([
    ["thread", new Set(["viewer"])], ["other", new Set(["viewer"])],
  ])
  const requests: Array<{ channelId: string; userId: string; signal: AbortSignal }> = []
  let nextGate = deferred()
  mocks.apiFetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url.startsWith("/api/community/servers/server/members")) {
      return Promise.resolve({ members: parentMembers, hasMore: false, limit: 50, total: 3 })
    }
    if (url === "/api/community/channels/parent/members?relation=access") {
      return Promise.resolve({ members: parentMembers })
    }
    const match = /^\/api\/community\/channels\/(thread|other)\/(members|participants)(?:\?relation=(?:access|notify))?$/.exec(url)
    if (!match) throw new Error(`Unexpected request: ${url}`)
    const channelId = match[1]
    if (options?.method === "POST") {
      const { userId } = JSON.parse(String(options.body)) as { userId: string }
      const gate = nextGate
      requests.push({ channelId, userId, signal: options.signal as AbortSignal })
      return gate.promise.then(() => {
        if (!options.signal?.aborted) roster.get(channelId)!.add(userId)
        return { success: true }
      })
    }
    return Promise.resolve({ members: parentMembers
      .filter((member) => roster.get(channelId)!.has(member.userId))
      .map((member) => ({ ...member, source: member.userId === "viewer" ? "spoke" : "added" })) })
  })
  const element = (channelId = "thread") => <CommunityTestProvider client={owner.client} registry={owner.registry}>
    <Harness key={channelId} channelId={channelId} />
  </CommunityTestProvider>
  const rendered = render(element())
  const open = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open picker" }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("Carol", { exact: true })).toBeTruthy())
    return within(screen.getByRole("dialog"))
  }
  const row = (name: string) => {
    const container = within(screen.getByRole("dialog")).getByText(name, { exact: true }).parentElement!
    return { container, button: within(container).getByRole("button") as HTMLButtonElement }
  }
  return { ...owner, rendered, element, requests, open, row,
    gate: () => nextGate,
    newGate: () => { nextGate = deferred(); return nextGate },
  }
}

describe("AddMembersDialog native membership lifecycle", () => {
  it("retains the admitted pending row during canonical optimistic insertion and removes it on success", async () => {
    const f = await fixture()
    await f.open()
    fireEvent.click(f.row("Bob").button)
    await waitFor(() => {
      expect(f.requests).toHaveLength(1)
      expect(f.registry.collections.channelMemberships.has(channelMembershipKey("thread", "bob", "notify"))).toBe(true)
      expect(f.row("Bob").button.disabled).toBe(true)
      expect(f.row("Bob").container.querySelector("svg.animate-spin")).not.toBeNull()
      expect(f.row("Carol").button.disabled).toBe(false)
    })
    fireEvent.click(f.row("Bob").button)
    expect(f.requests).toHaveLength(1)
    await act(async () => { f.gate().resolve(); await Promise.resolve() })
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByText("Bob", { exact: true })).toBeNull())
    expect(f.registry.collections.channelMemberships.has(channelMembershipKey("thread", "bob", "notify"))).toBe(true)
    expect(f.requests).toHaveLength(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("rolls back a failed Add and permits one new successful Retry", async () => {
    const f = await fixture()
    await f.open()
    fireEvent.click(f.row("Bob").button)
    await waitFor(() => { expect(f.requests).toHaveLength(1); expect(f.row("Bob").button.disabled).toBe(true) })
    await act(async () => { f.gate().reject(new Error("controlled Add failure")); await Promise.resolve() })
    await waitFor(() => {
      expect(f.row("Bob").button.disabled).toBe(false)
      expect(f.registry.collections.channelMemberships.has(channelMembershipKey("thread", "bob", "notify"))).toBe(false)
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
    })
    f.newGate()
    fireEvent.click(f.row("Bob").button)
    await waitFor(() => { expect(f.requests).toHaveLength(2); expect(f.row("Bob").button.disabled).toBe(true) })
    await act(async () => { f.gate().resolve(); await Promise.resolve() })
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByText("Bob", { exact: true })).toBeNull())
    expect(f.requests.map(({ userId }) => userId)).toEqual(["bob", "bob"])
  })

  it("does not borrow a retired pending intent after closing and returning through another scope", async () => {
    const f = await fixture()
    await f.open()
    fireEvent.click(f.row("Bob").button)
    await waitFor(() => { expect(f.requests).toHaveLength(1); expect(f.row("Bob").button.disabled).toBe(true) })
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(f.requests[0].signal.aborted).toBe(true)
    f.rendered.rerender(f.element("other"))
    await f.open()
    expect(f.row("Bob").button.disabled).toBe(false)
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }))
    f.rendered.rerender(f.element("thread"))
    const replacement = await f.open()
    expect(replacement.queryByText("Bob", { exact: true })).toBeNull()
    expect(f.row("Carol").button.disabled).toBe(false)
    expect(screen.getByRole("dialog").querySelector("svg.animate-spin")).toBeNull()
    await act(async () => { f.gate().resolve(); await Promise.resolve() })
    await waitFor(() => {
      expect(f.row("Bob").button.disabled).toBe(false)
      expect(f.registry.collections.channelMemberships.has(channelMembershipKey("thread", "bob", "notify"))).toBe(false)
    })
    expect(f.requests).toHaveLength(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
