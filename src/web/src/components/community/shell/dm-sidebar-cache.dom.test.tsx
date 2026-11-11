import "fake-indexeddb/auto"
import { useLayoutEffect } from "react"
import { dehydrate, useQueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { useDms } from "@/hooks/community/use-dms"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestDms } from "@/lib/community-db/sync"
import { clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER } from "@/lib/query-persister"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dmListRowFixture } from "@/test/community-resource-fixtures"
import { DmSidebarSlot } from "./dm-sidebar-slot"

const state = vi.hoisted(() => ({
  viewer: undefined as string | null | undefined,
  pending: true,
  error: null as Error | null,
  fetch: vi.fn(),
  replace: vi.fn(),
}))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: state.viewer ? { user: { id: state.viewer } } : null, isPending: state.pending, error: state.error }),
  currentSessionViewer: () => state.viewer,
}))
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => state.fetch(...args) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: state.replace }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/use-friends", () => ({ useFriends: () => ({ blocked: [] }), useFriendsPresence: () => undefined }))
vi.mock("@/hooks/community/use-inbox", () => ({ useInboxUnreads: () => ({ friendRequests: [] }) }))
vi.mock("@/lib/observability/regions", () => ({ useObservedRegion: () => undefined }))
vi.mock("@/lib/community/navigation-metadata", () => ({ prepareNavigationMetadata: () => Promise.resolve() }))
vi.mock("./community-route-context", () => ({ useCommunityRouteFrame: () => ({ frame: { href: "/c/me/friends" } }) }))

const emptyText = "Your direct messages will appear here."
const response = (id = "cached-dm", viewer = "viewer") => ({ conversations: [dmListRowFixture({
  id, userId: `${id}-peer`, name: id, discriminator: "0042", avatar: "P", avatarVersion: 0, status: "offline", preview: "Cached conversation",
}, viewer)] })
let mounted: ReturnType<typeof render> | undefined
let registry: CommunityDbRegistry
let latest: ReturnType<typeof useDms>
function Probe() {
  const client = useQueryClient()
  const owner = getCommunityDbRegistry(client)!
  const result = useDms(false, true)
  useLayoutEffect(() => { registry = owner; latest = result }, [owner, result])
  return null
}
function App({ account = "viewer" }: { account?: string }) {
  return <QueryProvider userId={account}><Probe /><DmSidebarSlot /></QueryProvider>
}
async function start(cached = true) {
  if (cached) {
    const owner = await createCommunityQueryOwner()
    ingestDms(owner.registry, response())
    const persister = createIdbPersister("viewer")
    await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) })
  }
  mounted = render(<App />)
  await waitFor(() => expect(registry?.restoration.get().captured).toBe(true))
  await act(async () => { await registry.preload() })
  registry.queryClient.setQueryDefaults(communityKeys.dms(), { retry: false })
  if (cached) await waitFor(() => expect(mounted!.getByTestId(tid.dmRow("cached-dm"))).toBeVisible())
  return mounted
}
function confirm(viewer = "viewer") {
  state.viewer = viewer; state.pending = false; state.error = null
  mounted!.rerender(<App account={viewer} />)
}
beforeEach(async () => {
  registry = undefined as unknown as CommunityDbRegistry
  state.viewer = undefined; state.pending = true; state.error = null
  state.fetch.mockReset(); state.replace.mockReset()
  await clearAllPersistedCaches()
})
afterEach(async () => {
  mounted?.unmount(); mounted = undefined
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await clearAllPersistedCaches()
})

it("restores readable DMs while initial session verification is held or fails, without granting requests", async () => {
  const view = await start()
  expect(state.fetch).not.toHaveBeenCalled()
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
  expect(latest.isDisplayReady).toBe(true)
  expect(() => registry.assertOnlineAccount()).toThrow(expect.objectContaining({ name: "AbortError" }))
  state.pending = false; state.error = new TypeError("Session offline")
  view.rerender(<App />)
  expect(view.getByTestId(tid.dmRow("cached-dm"))).toBeVisible()
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
  expect(state.fetch).not.toHaveBeenCalled()
  expect(() => registry.assertOnlineAccount()).toThrow(expect.objectContaining({ name: "AbortError" }))
})

it("starts the qualified DM request after matching confirmation and replaces restored rows", async () => {
  const view = await start()
  state.fetch.mockResolvedValue(response("fresh-dm"))
  await act(async () => confirm())
  await waitFor(() => expect(view.getByTestId(tid.dmRow("fresh-dm"))).toBeVisible())
  expect(view.queryByTestId(tid.dmRow("cached-dm"))).toBeNull()
  expect(state.fetch).toHaveBeenCalledOnce()
  expect(state.fetch).toHaveBeenCalledWith("/api/community/users/me/dms", expect.objectContaining({ authenticationAccount: "viewer" }))
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
})

it("keeps canonical cached rows when the first permitted transport request fails without any query result", async () => {
  const view = await start()
  state.fetch.mockRejectedValue(new TypeError("DM request offline"))
  await act(async () => confirm())
  await waitFor(() => expect(latest.isError).toBe(true))
  expect(latest.data).toBeUndefined()
  expect(latest.error).toBeInstanceOf(TypeError)
  expect(view.getByTestId(tid.dmRow("cached-dm"))).toBeVisible()
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
  state.fetch.mockResolvedValue(response("recovered-dm"))
  await act(async () => { await registry.queryClient.invalidateQueries({ queryKey: communityKeys.dms() }) })
  await waitFor(() => expect(view.getByTestId(tid.dmRow("recovered-dm"))).toBeVisible())
  expect(latest.isError).toBe(false)
})

it("retains readable rows and the actual error after a later background refresh fails", async () => {
  const view = await start(false)
  state.fetch.mockResolvedValue(response("live-dm"))
  await act(async () => confirm())
  await waitFor(() => expect(view.getByTestId(tid.dmRow("live-dm"))).toBeVisible())
  state.fetch.mockRejectedValue(new TypeError("Refresh offline"))
  await act(async () => { await registry.queryClient.invalidateQueries({ queryKey: communityKeys.dms() }) })
  await waitFor(() => expect(latest.isError).toBe(true))
  expect(view.getByTestId(tid.dmRow("live-dm"))).toBeVisible()
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
})

it("keeps an unknown list pending, shows a genuine first-load failure, and recovers through the existing Retry", async () => {
  const view = await start(false)
  expect(view.queryByText(emptyText)).toBeNull()
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
  expect(latest.isDisplayReady).toBe(false)
  expect(state.fetch).not.toHaveBeenCalled()
  state.fetch.mockRejectedValue(new TypeError("First request offline"))
  await act(async () => confirm())
  await waitFor(() => expect(view.getByRole("button", { name: "Retry" })).toBeVisible())
  expect(view.getByText("Couldn't load direct messages")).toBeVisible()
  const attempts = state.fetch.mock.calls.length
  state.fetch.mockResolvedValue(response("retry-dm"))
  fireEvent.click(view.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(view.getByTestId(tid.dmRow("retry-dm"))).toBeVisible())
  expect(state.fetch).toHaveBeenCalledTimes(attempts + 1)
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
})

it("keeps a confirmed empty list distinct from unknown and retains it after refresh failure", async () => {
  const view = await start(false)
  expect(view.queryByText(emptyText)).toBeNull()
  state.fetch.mockResolvedValue({ conversations: [] })
  await act(async () => confirm())
  await waitFor(() => expect(view.getByText(emptyText)).toBeVisible())
  expect(latest.isDisplayReady).toBe(true)
  state.fetch.mockRejectedValue(new TypeError("Empty refresh offline"))
  await act(async () => { await registry.queryClient.invalidateQueries({ queryKey: communityKeys.dms() }) })
  await waitFor(() => expect(latest.isError).toBe(true))
  expect(view.getByText(emptyText)).toBeVisible()
  expect(view.queryByTestId(tid.conversationLoadError)).toBeNull()
})

it("does not mistake a DM channel with missing canonical dependencies for a readable list or known empty", async () => {
  const view = await start()
  await act(async () => { await registry.collections.profiles.utils.writeDelete("cached-dm-peer") })
  await waitFor(() => expect(view.queryByTestId(tid.dmRow("cached-dm"))).toBeNull())
  expect(view.queryByText(emptyText)).toBeNull()
  expect(latest.isDisplayReady).toBe(false)
  state.fetch.mockRejectedValue(new TypeError("Cannot repair list"))
  await act(async () => confirm())
  await waitFor(() => expect(view.getByRole("button", { name: "Retry" })).toBeVisible())
})

it.each(["logout", "switch"] as const)("retires the restored account on %s and rejects its late list response", async mode => {
  const view = await start()
  let release!: (value: ReturnType<typeof response>) => void
  state.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  await act(async () => confirm())
  await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce())
  const old = registry
  if (mode === "logout") {
    state.viewer = null; state.pending = false
    view.rerender(<App />)
  } else {
    state.fetch.mockResolvedValue({ conversations: [] })
    await act(async () => confirm("replacement"))
    await waitFor(() => expect(registry.accountId).toBe("replacement"))
  }
  await waitFor(() => expect(view.queryByTestId(tid.dmRow("cached-dm"))).toBeNull())
  expect(old.runtime.lifecycle.get().active).toBe(false)
  await act(async () => { release(response("late-dm")) })
  expect(view.queryByTestId(tid.dmRow("late-dm"))).toBeNull()
  expect(old.queryClient.getQueryData(communityKeys.dms())).toBeUndefined()
  if (mode === "switch") expect(registry.collections.channels.get("late-dm")).toBeUndefined()
})
