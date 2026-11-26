import { BUSINESS_SCHEMA_VERSION, CommunityMembersReadSchema } from "@alook/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { serverMembersReadFixture } from "@/test/community-resource-fixtures"
import { channelMembershipKey } from "@/lib/community-db/schema"
import type { ChannelMember } from "@/hooks/community/use-channel-members"
import { useChannelMemberViewModel } from "./channel-member-view-model"
import { AddMembersDialog } from "./add-members-dialog"

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
  const memberRead = (channelId: string, relation: "access" | "notify", rows: ChannelMember[]) => CommunityMembersReadSchema.parse({
    contractVersion: BUSINESS_SCHEMA_VERSION, channelId, relation,
    members: rows.map(row => ({ channelId, userId: row.userId, relation, source: relation === "notify" ? row.userId === "viewer" ? "spoke" : "added" : row.source, isCreator: row.isCreator, role: row.role, memberId: row.id })),
    profiles: rows.map(row => ({ id: row.userId, name: row.name, discriminator: row.discriminator, avatar: null, avatarVersion: row.avatarVersion, statusEmoji: row.statusEmoji, statusText: row.statusText })),
  })
  const requests: Array<{ channelId: string; userId: string; signal: AbortSignal }> = []
  let nextGate = deferred()
  mocks.apiFetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url.startsWith("/api/community/servers/server/members")) {
      return Promise.resolve(serverMembersReadFixture("server", parentMembers.map(({ source: _source, isCreator: _creator, ...member }) => member), { total: 3 }))
    }
    if (url === "/api/community/channels/parent/members?relation=access") {
      return Promise.resolve(memberRead("parent", "access", parentMembers))
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
    return Promise.resolve(memberRead(channelId, "notify", parentMembers.filter(member => roster.get(channelId)!.has(member.userId))))
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
  it.each([false, true])("keeps a resolved cached picker read-only with Retry during failure (empty=%s)", async empty => {
    const owner = await createCommunityQueryOwner()
    const retry = vi.fn()
    const add = vi.fn().mockResolvedValue(undefined)
    const candidate = { userId: "bob", name: "Bob", avatar: "B" }
    const element = (failed: boolean) => <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <AddMembersDialog scopeId="cached-picker" title="Cached members" subtitle="Add people to this channel." candidates={failed && empty ? [] : [candidate]}
        queryState={{ resolved: true, loading: false, error: failed, actionable: !failed, retrying: false, retry }} onAdd={add} onClose={() => {}} />
    </CommunityTestProvider>
    const view = render(element(true))
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh people.")
    if (empty) expect(screen.getByText("Everyone is already here.")).toBeVisible()
    else { expect(screen.getByText("Bob")).toBeVisible(); expect(screen.getByRole("button", { name: "Add" })).toBeDisabled() }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
    view.rerender(element(false))
    expect(screen.queryByRole("alert")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(add).toHaveBeenCalledWith("bob", expect.any(Function)))
    view.unmount()
  })

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
    expect(f.registry.collections.channelMemberships.has(channelMembershipKey("thread", "bob", "notify"))).toBe(false)
    f.rendered.rerender(f.element("other"))
    await f.open()
    expect(f.row("Bob").button.disabled).toBe(false)
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }))
    f.rendered.rerender(f.element("thread"))
    const replacement = await f.open()
    expect(replacement.getByText("Bob", { exact: true })).toBeVisible()
    expect(f.row("Bob").button.disabled).toBe(false)
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

  it("virtualizes large candidate pools into a bounded row window", async () => {
    const manyCandidates = Array.from({ length: 500 }, (_, index) => ({
      userId: `user-${index}`,
      name: `Member ${index}`,
      avatar: "M",
    }))
    const { AddMembersDialog } = await import("./add-members-dialog")
    const owner = await createCommunityQueryOwner()
    const view = render(
      <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
        <AddMembersDialog
          title="Add members"
          subtitle="Pick members"
          candidates={manyCandidates}
          queryState={{ loading: false, resolved: true, error: false, retrying: false, retry: vi.fn() }}
          onAdd={vi.fn()}
          onClose={vi.fn()}
        />
      </CommunityTestProvider>,
    )
    const dialog = screen.getByRole("dialog")
    const renderedRows = dialog.querySelectorAll('[data-slot="people-picker-row"]')
    expect(renderedRows.length).toBeGreaterThan(0)
    expect(renderedRows.length).toBeLessThan(40)
    view.unmount()
  })
})
