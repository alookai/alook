
import { IsRestoringProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { serverDirectoryFixture, serverRailResponseFixture } from "@/test/community-resource-fixtures"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot, publishCommunityServerFields } from "@/lib/community-db/sync"
import { createOwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import { serversProjectedQueryFn } from "@/hooks/community/use-servers"
import { ServerSidebarSlot } from "../shell/server-sidebar-slot"
import { UserSettings } from "./user-settings"

const mocks = vi.hoisted(() => ({ load: vi.fn(), toast: vi.fn(), error: vi.fn(), replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => "/c/channels/target", useSearchParams: () => new URLSearchParams() }))
vi.mock("sonner", () => ({ toast: Object.assign(mocks.toast, { error: mocks.error, success: mocks.toast, warning: mocks.toast }) }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: mocks.load }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop", useIsMobile: () => false }))
vi.mock("@/hooks/community/use-server-members", () => ({ useServerMembers: () => ({ members: [] }) }))
vi.mock("@/hooks/community/use-server-panels", async original => ({ ...await original<typeof import("@/hooks/community/use-server-panels")>(), usePresence: () => {}, useInvites: () => ({ invites: [], isPending: false }) }))
vi.mock("@/hooks/community/use-bots", async original => ({ ...await original<typeof import("@/hooks/community/use-bots")>(), useBots: () => ({ bots: [] }) }))
vi.mock("@/hooks/community/use-billing", () => ({ useBilling: () => ({}) }))
vi.mock("@/components/community/billing/billing-sheet", () => ({ BillingContent: () => null }))
vi.mock("@/components/community/channels/channel-sidebar-tree-owner", () => ({ ChannelSidebarRevealBoundary: ({ onOpenSettings }: { onOpenSettings?: () => void }) => <button onClick={() => onOpenSettings?.()}>Open server settings</button> }))

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => { vi.clearAllMocks(); mocks.load.mockImplementation(() => new Promise(() => {})) })

async function serverFixture(accountId = "viewer") {
  const { client, registry } = await createCommunityQueryOwner(accountId)
  const server = { id: "target", name: "Original", discriminator: "0001", description: "Original description", icon: null, ownerId: accountId }
  mocks.load.mockResolvedValueOnce(serverRailResponseFixture({ servers: [{ ...server, role: "owner", isOwner: true, memberId: "membership" }] }, accountId))
  await client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(client) })
  await publishCommunityLiveSnapshot(client, { snapshot: { kind: "server-detail", data: serverDirectoryFixture({ ...server, categories: [] }) }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
  const pending: Array<ReturnType<typeof deferred<{ name: string; description: string }>> & { input: { name: string; description: string } }> = []
  mocks.load.mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/community/servers/target" && options?.method === "PATCH") {
      const gate = { ...deferred<{ name: string; description: string }>(), input: JSON.parse(options.body as string) }
      pending.push(gate)
      return gate.promise
    }
    return new Promise(() => {})
  })
  const token = createOwnerServerDeleteRouteToken(client)
  const node = () => <CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: accountId, name: accountId, avatar: "V", email: `${accountId}@example.test` }}>
      <IsRestoringProvider value>
        <CommunityRouteContext value={{ frame: { ...normalizeCommunityHref("/c/channels/target"), revision: 1 }, navigation: { captureIntent: () => () => true, navigationPending: false, pendingHref: null }, ownerDeleteRouteScope: { serverId: "target", token } } as never}>
          <ServerSidebarSlot serverId="target" />
        </CommunityRouteContext>
      </IsRestoringProvider>
    </CurrentUserProvider>
  </CommunityTestProvider>
  return { client, registry, pending, node }
}

async function openServer(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: "Open server settings" }))
  return await view.findByRole("textbox", { name: "Server name" }) as HTMLInputElement
}

describe("Sidebar-owned settings acceptance", () => {
  it("keeps edit B dirty after accepting submitted A, then cancels to accepted A", async () => {
    const fixture = await serverFixture(), view = render(fixture.node())
    const name = await openServer(view)
    fireEvent.change(name, { target: { value: "A" } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(fixture.pending).toHaveLength(1))
    expect(fixture.registry.collections.servers.get("target")?.name).toBe("A")
    fireEvent.change(name, { target: { value: "B" } })
    await act(async () => { await publishCommunityServerFields(fixture.client, "target", { name: "WS canonical" }, { token: captureCommunityLiveSnapshotToken(fixture.client), signal: undefined }) })
    expect(name).toHaveValue("B")
    await act(async () => fixture.pending[0].resolve(fixture.pending[0].input))
    await waitFor(() => expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled())
    expect(name).toHaveValue("B")
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("Server updated")
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(name).toHaveValue("A")
    expect(view.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("retains rejected draft and retries it instead of accepting an optimistic baseline", async () => {
    const fixture = await serverFixture(), view = render(fixture.node())
    const name = await openServer(view)
    fireEvent.change(name, { target: { value: "A" } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(fixture.pending).toHaveLength(1))
    await act(async () => fixture.pending[0].reject(new Error("rejected")))
    await waitFor(() => expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled())
    expect(name).toHaveValue("A")
    expect(mocks.error).toHaveBeenCalledOnce()
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(fixture.pending).toHaveLength(2))
    expect(fixture.pending[1].input.name).toBe("A")
    await act(async () => fixture.pending[1].reject(new Error("rejected again")))
    await waitFor(() => expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled())
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(name).toHaveValue("Original")
  })

  it.each(["accept", "reject"] as const)("retains a pending editor through close/reopen and %s", async outcome => {
    const fixture = await serverFixture(), view = render(fixture.node())
    let name = await openServer(view)
    fireEvent.change(name, { target: { value: "A" } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(fixture.pending).toHaveLength(1))
    expect(fixture.registry.collections.servers.get("target")?.name).toBe("A")
    fireEvent.change(name, { target: { value: "B" } })
    fireEvent.click(view.getByRole("button", { name: "Close settings" }))
    await waitFor(() => expect(view.queryByRole("textbox", { name: "Server name" })).toBeNull())
    name = await openServer(view)
    expect(name).toHaveValue("B")
    expect(view.getByRole("button", { name: "Save changes" })).toBeDisabled()
    mocks.toast.mockClear(); mocks.error.mockClear()
    await act(async () => outcome === "accept" ? fixture.pending[0].resolve(fixture.pending[0].input) : fixture.pending[0].reject(new Error("rejected")))
    await waitFor(() => expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled())
    expect(name).toHaveValue("B")
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(name).toHaveValue(outcome === "accept" ? "A" : "Original")
  })
  it("refreshes a closed settled editor from current canonical fields on the next open", async () => {
    const fixture = await serverFixture(), view = render(fixture.node())
    await openServer(view)
    fireEvent.click(view.getByRole("button", { name: "Close settings" }))
    await waitFor(() => expect(view.queryByRole("textbox", { name: "Server name" })).toBeNull())
    await act(async () => { await publishCommunityServerFields(fixture.client, "target", { name: "New canonical" }, { token: captureCommunityLiveSnapshotToken(fixture.client), signal: undefined }) })
    expect(await openServer(view)).toHaveValue("New canonical")
  })

  it.each((["accept", "reject"] as const).flatMap(outcome => ["viewer", "other-viewer"].map(accountId => ({ outcome, accountId }))))("does not deliver old $outcome into replacement owner $accountId", async ({ outcome, accountId }) => {
    const old = await serverFixture(), view = render(old.node())
    fireEvent.change(await openServer(view), { target: { value: "Old A" } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(old.pending).toHaveLength(1))
    const replacement = await serverFixture(accountId)
    expect(replacement.registry.accountId).toBe(accountId)
    view.rerender(replacement.node())
    const name = await view.findByRole("textbox", { name: "Server name" })
    expect(name).toHaveValue("Original")
    fireEvent.change(name, { target: { value: "New draft" } })
    mocks.toast.mockClear(); mocks.error.mockClear()
    await act(async () => outcome === "accept" ? old.pending[0].resolve(old.pending[0].input) : old.pending[0].reject(new Error("old rejected")))
    expect(name).toHaveValue("New draft")
    expect(replacement.registry.collections.servers.get("target")?.name).toBe("Original")
    expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
  })

})

describe("profile draft acceptance", () => {
  async function fixture() {
    const owner = await createCommunityQueryOwner()
    const pending = deferred<void>(), onSave = vi.fn(() => pending.promise)
    const props = { onClose: vi.fn(), userId: "viewer", userName: "Original", userEmail: "viewer@example.test", aboutMe: "Original about", avatar: "V", statusEmoji: null, statusText: null, onSave, onAccountDeleted: vi.fn(async () => {}) }
    const node = (overrides: Partial<typeof props> = {}) => <CommunityTestProvider client={owner.client} registry={owner.registry}><UserSettings {...props} {...overrides} /></CommunityTestProvider>
    return { ...owner, pending, onSave, node }
  }

  it("normalizes only unchanged submission fields and keeps later B dirty across a canonical echo", async () => {
    const f = await fixture(), view = render(f.node())
    const name = view.getByRole("textbox", { name: "Display name" })
    const about = view.getByPlaceholderText("Add a bit about yourself…")
    fireEvent.change(about, { target: { value: " About A " } })
    fireEvent.change(name, { target: { value: " A " } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(f.onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "A" })))
    fireEvent.change(name, { target: { value: " B " } })
    view.rerender(f.node({ userName: "Canonical echo" }))
    expect(name).toHaveValue(" B ")
    await act(async () => f.pending.resolve())
    await waitFor(() => expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled())
    expect(name).toHaveValue(" B ")
    expect(about).toHaveValue("About A")
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(name).toHaveValue("A")
  })

  it("keeps rejected values dirty and Cancel restores the last accepted profile", async () => {
    const f = await fixture(), view = render(f.node())
    const name = view.getByRole("textbox", { name: "Display name" })
    fireEvent.change(name, { target: { value: "Rejected" } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce())
    await act(async () => f.pending.reject(new Error("rejected")))
    await waitFor(() => expect(view.getByRole("button", { name: "Save changes" })).toBeEnabled())
    expect(name).toHaveValue("Rejected")
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(name).toHaveValue("Original")
  })

  it("does not surface a retired profile save failure", async () => {
    const f = await fixture(), view = render(f.node())
    fireEvent.change(view.getByRole("textbox", { name: "Display name" }), { target: { value: "A" } })
    fireEvent.click(view.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(f.onSave).toHaveBeenCalledOnce())
    view.unmount()
    mocks.error.mockClear()
    await act(async () => f.pending.reject(new Error("late rejected")))
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
