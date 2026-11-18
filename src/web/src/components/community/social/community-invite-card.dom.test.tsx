import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dehydrate, QueryClient } from "@tanstack/react-query"
import { persistQueryClientRestore } from "@tanstack/react-query-persist-client"
import { get } from "idb-keyval"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { fullResourceBundleFixture, profileResourceFixture } from "@/test/community-resource-fixtures"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, discardCommunityRestoreReplacements, publishCommunityResourceBundle, restoreCommunityCollections } from "@/lib/community-db/sync"
import { blobKeyFor } from "@/lib/persisted-account-identity"
import { cacheStore } from "@/lib/query-cache-store"
import { communityKeys } from "@/lib/query-keys"
import { clearPersistedCache, createCommunityRestorePersister, createIdbPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldDehydrateCommunityQuery } from "@/lib/query-persister"
import { ApiError } from "@/lib/errors"

const mocks = vi.hoisted(() => ({ api: vi.fn(), join: vi.fn(), push: vi.fn(), toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api, toastApiError: vi.fn() }))
vi.mock("@/contexts/community/module-route", () => ({ useCommunityRouter: () => ({ push: mocks.push }) }))
vi.mock("@/hooks/community/use-servers", () => ({ useServers: () => ({ servers: [] }) }))
vi.mock("@/hooks/community/mutations/servers", () => ({ useJoinServer: () => ({ mutateAsync: mocks.join, isPending: false }) }))
vi.mock("sonner", () => ({ toast: mocks.toast }))
import { CommunityInviteCard } from "./community-invite-card"

type Owner = { account: string; client: QueryClient; registry: CommunityDbRegistry }
const owners = new Set<CommunityDbRegistry>()
const accounts = new Set<string>()
const persisters: ReturnType<typeof createIdbPersister>[] = []
const info = (name = "Saved server") => ({ serverId: "remote", serverName: name, serverIcon: null, memberCount: 3 })
const element = (owner: Owner, token = "one") => <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner><CommunityInviteCard token={token} perspective="recipient" /></CommunityTestProvider>

beforeEach(() => {
  mocks.api.mockReset().mockResolvedValue(info())
  mocks.join.mockReset().mockResolvedValue({ serverId: "remote" })
  mocks.push.mockReset()
  mocks.toast.mockReset()
})
afterEach(async () => {
  for (const persister of persisters.splice(0)) persister.stopPersisting()
  for (const registry of owners) { await registry.cleanup(); registry.queryClient.clear() }
  owners.clear()
  for (const account of accounts) await clearPersistedCache(account)
  accounts.clear()
})

async function createOwner(): Promise<Owner> {
  const account = `invite-card-${crypto.randomUUID()}`
  accounts.add(account)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const registry = createCommunityDbRegistry(client, account)
  owners.add(registry)
  await registry.preload()
  await publishCommunityResourceBundle(client, fullResourceBundleFixture(account, [], [], [], [profileResourceFixture({ id: account })]), { token: captureCommunityLiveSnapshotToken(client) })
  return { account, client, registry }
}
async function writeSnapshot(owner: Owner, writer: ReturnType<typeof createIdbPersister>) {
  const snapshot = { timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client, { shouldDehydrateQuery: shouldDehydrateCommunityQuery }) }
  await writer.persistClient(snapshot)
  expect(JSON.parse((await get<string>(blobKeyFor(owner.account), cacheStore))!).timestamp).toBe(snapshot.timestamp)
  return snapshot
}
async function restoreSavedOwner(source: Owner): Promise<Owner> {
  await source.registry.cleanup()
  owners.delete(source.registry)
  source.client.clear()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let release!: () => void
  const registry = createCommunityDbRegistry(client, source.account, { waitForRestore: new Promise<void>(resolve => { release = resolve }) })
  owners.add(registry)
  const reader = createIdbPersister(source.account)
  persisters.push(reader)
  registry.bindAuthentication(() => source.account, reader.retireAccount, reader.retireChannels, reader.retireAuxiliaryScopes)
  const restore = createCommunityRestorePersister(reader, source.account)
  await persistQueryClientRestore({ queryClient: client, persister: restore.persister, buster: PERSIST_BUSTER, maxAge: PERSIST_MAX_AGE_MS })
  const input = restore.takeCollections()
  try { await restoreCommunityCollections(registry, input); registry.captureRestoredCollections(input); registry.runtime.ws.actions.activateProfileAccount(source.account) }
  finally { discardCommunityRestoreReplacements(registry); release() }
  await registry.preload()
  return { account: source.account, client, registry }
}

describe("actual invite card read ownership", () => {
  it.each([403, 503, 404, 410])("classifies an actual no-data HTTP %s without inventing an expired invitation", async status => {
    const owner = await createOwner()
    mocks.api.mockRejectedValue(new ApiError("Controlled invite read failure", status))
    const view = render(element(owner))
    await waitFor(() => expect(screen.queryByText("Couldn't load invite.") !== null || screen.queryByText("This invite has expired or is no longer valid.") !== null).toBe(true))
    const invalid = status === 404 || status === 410
    expect(screen.queryByText("This invite has expired or is no longer valid.") !== null).toBe(invalid)
    expect(screen.queryByRole("button", { name: "Retry" }) !== null).toBe(!invalid)
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull()
    expect(mocks.join).not.toHaveBeenCalled()
    view.unmount()
  })

  it("restores the actual card read through IDB, keeps it read-only on failure, and only joins after a current Retry", async () => {
    const source = await createOwner()
    const first = render(element(source))
    await waitFor(() => expect(screen.getByRole("button", { name: "Join" })).toBeEnabled())
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    first.unmount()
    await writeSnapshot(source, writer)
    writer.stopPersisting()
    const second = await restoreSavedOwner(source)
    expect(second.registry).not.toBe(source.registry)
    expect(second.client.getQueryData(communityKeys.inviteInfo("one"))).toMatchObject({ serverName: "Saved server", observed: false })
    mocks.api.mockRejectedValue(new ApiError("Controlled offline refresh", 503))
    const restored = render(element(second))
    await waitFor(() => expect(screen.getByText("Couldn't refresh invite.")).toBeVisible())
    expect(screen.getByText("Saved server")).toBeVisible()
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Join" }))
    expect(mocks.join).not.toHaveBeenCalled()
    const resaver = createIdbPersister(second.account)
    persisters.push(resaver)
    restored.unmount()
    await writeSnapshot(second, resaver)
    resaver.stopPersisting()
    const third = await restoreSavedOwner(second)
    expect(third.registry).not.toBe(second.registry)
    expect(third.client.getQueryData(communityKeys.inviteInfo("one"))).toMatchObject({ serverName: "Saved server", observed: false })
    const view = render(element(third))
    await waitFor(() => expect(screen.getByText("Couldn't refresh invite.")).toBeVisible())
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled()
    mocks.api.mockResolvedValue(info())
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Join" })).toBeEnabled())
    await act(async () => {
      await third.client.invalidateQueries({ queryKey: communityKeys.inviteInfo("one"), exact: true, refetchType: "none" })
      fireEvent.click(screen.getByRole("button", { name: "Join" }))
    })
    expect(mocks.join).not.toHaveBeenCalled()
    await act(async () => { await third.client.refetchQueries({ queryKey: communityKeys.inviteInfo("one"), exact: true }) })
    fireEvent.click(screen.getByRole("button", { name: "Join" }))
    await waitFor(() => expect(mocks.join).toHaveBeenCalledExactlyOnceWith({ inviteCode: "one" }))
    expect(mocks.push).toHaveBeenCalledWith("/c/channels/remote")
    view.unmount()
  })

  it("retires an actual 404 token so a late old writer cannot restore its former card", async () => {
    const source = await createOwner()
    const view = render(element(source))
    await waitFor(() => expect(screen.getByText("Saved server")).toBeVisible())
    const writer = createIdbPersister(source.account)
    persisters.push(writer)
    source.registry.bindAuthentication(() => source.account, writer.retireAccount, writer.retireChannels, writer.retireAuxiliaryScopes)
    const snapshot = await writeSnapshot(source, writer)
    mocks.api.mockRejectedValue(new ApiError("Token was revoked", 404))
    await act(async () => { await expect(source.client.refetchQueries({ queryKey: communityKeys.inviteInfo("one"), exact: true }, { throwOnError: true })).rejects.toMatchObject({ status: 404 }) })
    await waitFor(() => expect(screen.getByText("This invite has expired or is no longer valid.")).toBeVisible())
    expect(screen.queryByText("Saved server")).toBeNull()
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull()
    view.unmount()
    await writer.persistClient({ ...snapshot, timestamp: snapshot.timestamp + 1 })
    writer.stopPersisting()
    const second = await restoreSavedOwner(source)
    expect(second.client.getQueryData(communityKeys.inviteInfo("one"))).toBeUndefined()
    expect(second.registry.collections.profiles.has(source.account)).toBe(true)
  })

  it("does not navigate a replacement card when an older admitted Join finishes late", async () => {
    const owner = await createOwner()
    let finish!: (result: { serverId: string }) => void
    mocks.join.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(element(owner))
    await waitFor(() => expect(screen.getByRole("button", { name: "Join" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Join" }))
    expect(mocks.join).toHaveBeenCalledOnce()
    mocks.api.mockResolvedValue(info("Replacement server"))
    view.rerender(element(owner, "two"))
    await waitFor(() => expect(screen.getByText("Replacement server")).toBeVisible())
    await act(async () => { finish({ serverId: "remote" }); await Promise.resolve() })
    expect(mocks.push).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
    view.unmount()
  })
})
