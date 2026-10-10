import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { useShellProfileController } from "./use-shell-profile-controller"

const mocks = vi.hoisted(() => ({ viewer: "A", api: vi.fn() }))
vi.mock("@/lib/api/client", async (original) => ({
  ...await original<typeof import("@/lib/api/client")>(),
  apiFetch: mocks.api,
}))
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: mocks.viewer } }, isPending: false, error: null }),
  currentSessionViewer: () => mocks.viewer,
  signOutWithOrigin: vi.fn(),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: mocks.viewer, name: "Viewer", email: "viewer@example.test", avatar: "V", avatarVersion: 0, presence: "online" }),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/c/channels/server/channel",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/hooks/community/use-server-members", () => ({
  useServerMembers: () => ({ members: [
    { id: "member-peer", userId: "peer", name: "Peer", discriminator: "0001", role: "member" },
    { id: "member-other", userId: "other", name: "Peer", discriminator: "0002", role: "member" },
  ] }),
}))

const peer = { id: "relationship-peer", userId: "peer", name: "Peer", discriminator: "0001", avatar: "P", avatarVersion: 0, status: "offline", sub: "" }
const empty = { friends: [], pending: [], blocked: [] }
type Buckets = { friends: unknown[]; pending: unknown[]; blocked: unknown[] }
function response(path: string, buckets: Buckets = { ...empty, friends: [peer] }) {
  if (path.endsWith("/accepted")) return { friends: buckets.friends }
  if (path.endsWith("/pending")) return { pending: buckets.pending }
  if (path.endsWith("/blocked")) return { blocked: buckets.blocked }
  if (path.endsWith("/profile")) return { id: path.split("/").at(-2), name: "Peer", discriminator: "0001", image: null, avatarVersion: 0, kind: "human", aboutMe: "", mutualServers: 0, statusEmoji: null, statusText: null }
  throw new Error("Unexpected relationship fixture request: " + path)
}
type Held = { viewer: string; path: string; signal: AbortSignal; resolve: (value: unknown) => void }
function holdFriends() {
  const held: Held[] = []
  mocks.api.mockImplementation((path: string, options: { signal: AbortSignal }) => {
    if (!path.includes("/friends/")) return Promise.resolve(response(path))
    return new Promise((resolve) => held.push({ viewer: mocks.viewer, path, signal: options.signal, resolve }))
  })
  return held
}

async function mountController() {
  let current!: ReturnType<typeof useShellProfileController>
  let client!: QueryClient
  const router = { captureIntent: () => () => true, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }
  function Probe() {
    client = useQueryClient()
    current = useShellProfileController({ queryClient: client, router, cancelPendingNavigation: vi.fn(), view: "server", activeServerId: "server" })
    return null
  }
  function Root({ viewer }: { viewer: string }) {
    return <QueryProvider userId={viewer}><Probe /></QueryProvider>
  }
  const view = render(<Root viewer={mocks.viewer} />)
  await waitFor(() => expect(client).toBeDefined())
  await act(async () => { await getCommunityDbRegistry(client)!.ready; await getCommunityDbRegistry(client)!.preload() })
  return {
    get current() { return current },
    get client() { return client },
    view,
    open(userId: string | undefined, name = "Peer") {
      act(() => current.openProfile(name, { clientX: 1, clientY: 1 } as never, undefined, userId))
    },
    switchAccount(viewer: string) {
      act(() => { mocks.viewer = viewer; view.rerender(<Root viewer={viewer} />) })
    },
  }
}
beforeEach(async () => {
  await clearAllPersistedCaches()
  mocks.viewer = "A"
  mocks.api.mockReset().mockImplementation((path: string) => Promise.resolve(response(path)))
})

describe("profile message visibility from the existing relationship owner", () => {
  it("matches accepted userId rather than friendship id or a same-name member and resets on target changes", async () => {
    const hook = await mountController()
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    hook.open("peer")
    await waitFor(() => expect(hook.current.canMessage).toBe(true))
    hook.open("other")
    expect(hook.current.profile?.data.userId).toBe("other")
    expect(hook.current.canMessage).toBe(false)
    hook.open("relationship-peer", "Missing")
    expect(hook.current.canMessage).toBe(false)
    hook.open("A")
    expect(hook.current.canMessage).toBe(false)
    hook.open(undefined, "Missing")
    expect(hook.current.profile?.data.userId).toBeUndefined()
    expect(hook.current.canMessage).toBe(false)
  })

  it.each([false, true])("uses the accepted self-bot source with known blocked=%s taking precedence", async (blocked) => {
    const bot = { ...peer, id: "self-bot:bot", userId: "bot" }
    mocks.api.mockImplementation((path: string) => Promise.resolve(response(path, { ...empty, friends: [bot], blocked: blocked ? [bot] : [] })))
    const hook = await mountController()
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    hook.open("bot")
    await waitFor(() => expect(hook.current.canMessage).toBe(!blocked))
  })

  it("keeps canonical accepted rows closed until the first query is confirmed and does not label a first failed read as friendship", async () => {
    const held = holdFriends(), hook = await mountController()
    await waitFor(() => expect(held).toHaveLength(3))
    await act(async () => getCommunityDbRegistry(hook.client)!.collections.friendships.utils.writeUpsert({ id: peer.id, userId: peer.userId, kind: "accepted" }))
    hook.open("peer")
    expect(hook.current.canMessage).toBe(false)
    await act(async () => { for (const request of held) request.resolve(response(request.path, empty)) })
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    expect(hook.current.canMessage).toBe(false)
    hook.view.unmount()
    mocks.api.mockImplementation((path: string) => path.includes("/friends/") ? Promise.reject(new Error("initial relationship read failed")) : Promise.resolve(response(path)))
    const failed = await mountController()
    failed.open("peer")
    await waitFor(() => expect(failed.client.getQueryState(communityKeys.friends())?.status).toBe("error"), { timeout: 3000 })
    expect(failed.client.getQueryData(communityKeys.friends())).toBeUndefined()
    expect(failed.current.canMessage).toBe(false)
  })

  it.each(["incoming", "outgoing"] as const)("follows accepted and removed WS facts for a %s request in the same cache", async (kind) => {
    mocks.api.mockImplementation((path: string) => Promise.resolve(response(path, { ...empty, pending: [{ ...peer, kind }] })))
    const hook = await mountController()
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    hook.open("peer")
    expect(hook.current.canMessage).toBe(false)
    act(() => projectCommunityWsEventToDb(hook.client, { type: "community:friend.accept", friendshipId: peer.id }))
    await waitFor(() => expect(hook.current.canMessage).toBe(true))
    act(() => projectCommunityWsEventToDb(hook.client, { type: "community:friend.remove", friendshipId: peer.id }))
    await waitFor(() => expect(hook.current.canMessage).toBe(false))
  })

  it.each(["error", "stale"] as const)("preserves a previous good query and accepted projection after a refresh %s", async (mode) => {
    const hook = await mountController()
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    hook.open("peer")
    await waitFor(() => expect(hook.current.canMessage).toBe(true))
    mocks.api.mockImplementation((path: string) => !path.includes("/friends/") ? Promise.resolve(response(path)) : mode === "error" ? Promise.reject(new Error("refresh failed")) : Promise.resolve({ ...response(path), stale: true }))
    await act(async () => { await hook.client.refetchQueries({ queryKey: communityKeys.friends(), exact: true }) })
    expect(hook.client.getQueryState(communityKeys.friends())?.status).toBe("error")
    expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined()
    expect(hook.current.canMessage).toBe(true)
  })

  it("does not let a late accepted snapshot restore permission after a known block", async () => {
    const hook = await mountController()
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    hook.open("peer")
    await waitFor(() => expect(hook.current.canMessage).toBe(true))
    const held = holdFriends()
    let refresh!: Promise<void>
    act(() => { refresh = hook.client.refetchQueries({ queryKey: communityKeys.friends(), exact: true }) })
    await waitFor(() => expect(held).toHaveLength(3))
    act(() => projectCommunityWsEventToDb(hook.client, { type: "community:friend.block", userId: "peer", blockedByViewer: true }))
    await waitFor(() => expect(hook.current.canMessage).toBe(false))
    await act(async () => { for (const request of held) request.resolve(response(request.path)); await refresh })
    expect(hook.current.canMessage).toBe(false)
    expect(getCommunityDbRegistry(hook.client)!.collections.friendships.get("blocked:peer")?.kind).toBe("blocked")
  })

  it("retires account A and its late reads before account B can acquire any permission", async () => {
    const hook = await mountController()
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    hook.open("peer")
    await waitFor(() => expect(hook.current.canMessage).toBe(true))
    const original = hook.client, held = holdFriends()
    act(() => { void original.refetchQueries({ queryKey: communityKeys.friends(), exact: true }) })
    await waitFor(() => expect(held.filter((request) => request.viewer === "A")).toHaveLength(3))
    hook.switchAccount("B")
    await waitFor(() => expect(held.filter((request) => request.viewer === "B")).toHaveLength(3))
    expect(hook.client).not.toBe(original)
    hook.open("peer")
    expect(hook.current.canMessage).toBe(false)
    const fromA = held.filter((request) => request.viewer === "A")
    await waitFor(() => expect(fromA.every((request) => request.signal.aborted)).toBe(true))
    await act(async () => { for (const request of fromA) request.resolve(response(request.path)) })
    expect(hook.current.canMessage).toBe(false)
    await act(async () => { for (const request of held.filter((request) => request.viewer === "B")) request.resolve(response(request.path, empty)) })
    await waitFor(() => expect(hook.client.getQueryData(communityKeys.friends())).toBeDefined())
    expect(hook.current.canMessage).toBe(false)
    expect([...getCommunityDbRegistry(hook.client)!.collections.friendships.values()]).toHaveLength(0)
  })
})
