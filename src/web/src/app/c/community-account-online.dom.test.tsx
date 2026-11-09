import "fake-indexeddb/auto"
import React, { useEffect } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { dehydrate, QueryClient, useQueryClient } from "@tanstack/react-query"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION } from "@alook/shared"
import { clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER, readPersistedAccountIdentity } from "@/lib/query-persister"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { createCommunityDbRegistry } from "@/lib/community-db/collections"
import { createQueryClient } from "@/lib/query-client"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { communityKeys } from "@/lib/query-keys"
import { useServers, useViewerServerRole, serversProjectedQueryFn } from "@/hooks/community/use-servers"
import { useCreateServer } from "@/hooks/community/mutations/servers"
import { apiFetch } from "@/lib/api/client"
import { runApplicationRequest, useApplicationOwner } from "@/lib/application-owner"
import { serverRailResponseFixture } from "@/test/community-resource-fixtures"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"

const backend = vi.hoisted(() => { const transport = vi.fn(); vi.stubGlobal("fetch", transport); return transport })
const navigation = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me/machines", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: navigation.replace }), notFound: vi.fn() }))
vi.mock("@/components/community/shell/use-hydrated-client", () => ({ useHydratedClient: () => true }))
vi.mock("@/components/authenticated-context-menu-boundary", () => ({ AuthenticatedContextMenuBoundary: ({ children }: React.PropsWithChildren) => children }))
vi.mock("@/components/authenticated-native-oauth-cleanup", () => ({ AuthenticatedNativeOauthCleanup: () => null }))
vi.mock("@/components/signup-tracker", () => ({ SignupTracker: () => null }))
vi.mock("@/components/community/shell/community-route-frame", () => ({ CommunityRouteFrame: () => null }))
vi.mock("@/app/c/community-shell", () => ({ CommunityShell: ({ currentUser, children }: React.PropsWithChildren<{ currentUser: { id: string } }>) => <QueryProvider userId={currentUser.id}><Probe id={currentUser.id} />{children}</QueryProvider> }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
import { authClient, currentSessionViewer } from "@/lib/auth-session"
import { CommunityLayoutClient } from "./community-layout-client"
import { QueryProvider } from "./QueryProvider"

type Owner = { registry: CommunityDbRegistry; createServer: ReturnType<typeof useCreateServer>; application: ReturnType<typeof useApplicationOwner> }
const owners = new Map<string, Owner>()
function Probe({ id }: { id: string }) {
  const client = useQueryClient(), registry = getCommunityDbRegistry(client)!
  const servers = useServers(), role = useViewerServerRole("private-b", id)
  const createServer = useCreateServer(), application = useApplicationOwner()
  useEffect(() => { owners.set(id, { registry, createServer, application }) }, [id, registry, createServer, application])
  return <><output>{id}</output><output aria-label="Server list">{servers.servers.map(server => server.name).join(",")}</output><output aria-label="Live authority">{String(servers.isLiveAuthoritative)}</output><output aria-label="B role">{role ?? "none"}</output><input aria-label="Draft" /></>
}
let mounted: ReturnType<typeof render> | undefined
let releaseSession!: (response: Response) => void
let sessionStarts = 0
let businessUser = "online-b"
let sessionMode: "held" | "offline" | "guest" = "held"
const businessCalls = () => backend.mock.calls.filter(([input]) => new URL(String(input), "http://localhost").pathname.startsWith("/api/community/"))
const response = (body: unknown) => Response.json(body, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) } })
const rail = (id: string) => serverRailResponseFixture({ servers: [{ id: id === "online-b" ? "private-b" : "private-a", name: `${id} server`, ownerId: id, role: "owner", memberId: `${id}-member` }] }, id)
const sessionResponse = (id: string) => {
  const now = new Date().toISOString()
  return Response.json({ user: { id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now }, session: { id: `${id}-session`, token: "fixture-only", userId: id, expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: now, updatedAt: now } })
}
beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
  owners.clear(); navigation.replace.mockClear(); await clearAllPersistedCaches()
  businessUser = "online-b"; sessionMode = "held"
  backend.mockReset().mockImplementation(async (input: unknown, options?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname
    if (path.endsWith("/get-session")) {
      sessionStarts++
      if (sessionMode === "offline") throw new TypeError("Offline")
      if (sessionMode === "guest") return Response.json(null)
      return new Promise<Response>(resolve => { releaseSession = resolve })
    }
    if (path === "/api/community/servers" && options?.method === "POST") return response({ server: { id: "created-a-server" } })
    if (path === "/api/community/servers") return response(rail(businessUser))
    if (path === "/api/community/test-command") return new Response(null, { status: 204, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_CONTRACT_VERSION) } })
    throw new Error(`Unexpected transport ${path}`)
  })
  const seed = new QueryClient()
  seed.setQueryData(communityKeys.communityDbCollection("cached-a", "profiles"), [{ id: "cached-a", name: "Cached A", discriminator: "4242", avatar: null, avatarVersion: 0, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: "" }])
  seed.setQueryData(communityKeys.communityDbCollection("cached-a", "servers"), [{ id: "cached-server-a", position: 0, name: "Cached A server", discriminator: "4242", description: "", ownerId: "cached-a", icon: null, official: false, isOwner: true }])
  seed.setQueryData(communityKeys.communityDbCollection("cached-a", "serverMemberships"), [{ id: "cached-server-a:cached-a", serverId: "cached-server-a", userId: "cached-a", memberId: "cached-a-membership", role: "owner", viewer: true }])
  const writer = createIdbPersister("cached-a")
  await writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(seed) })
  await writer.rememberAccountIdentity({ id: "cached-a", email: "cached-a@example.test" }, () => undefined)
  await waitFor(async () => expect(await readPersistedAccountIdentity()).toEqual({ id: "cached-a", email: "cached-a@example.test" }))
  seed.clear()
})
afterEach(async () => {
  mounted?.unmount(); mounted = undefined
  sessionMode = "guest"
  await act(async () => authClient.$store.atoms.session.get().refetch())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
  await clearAllPersistedCaches()
})
async function cachedView() {
  mounted = render(<CommunityLayoutClient />)
  await screen.findByText("cached-a")
  await waitFor(() => expect(screen.getByLabelText("Server list")).toHaveTextContent("Cached A server"))
  await waitFor(() => expect(owners.has("cached-a")).toBe(true))
  return owners.get("cached-a")!
}
async function assertBlocked(owner: Owner) {
  const client = owner.registry.queryClient
  await expect(client.query({ queryKey: ["unconfirmed-diagnostic"], queryFn: serversProjectedQueryFn(client), retry: false })).rejects.toMatchObject({ name: "AbortError" })
  expect(() => publishCommunityLiveSnapshot(client, { snapshot: { kind: "servers", data: { servers: [] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } })).toThrow(expect.objectContaining({ name: "AbortError" }))
  await expect(Promise.resolve().then(() => owner.createServer.mutateAsync({ name: "A local server name" }))).rejects.toMatchObject({ name: "AbortError" })
  await expect(runApplicationRequest(owner.application, options => apiFetch("/api/community/test-command", { ...options, method: "POST" }))).rejects.toMatchObject({ name: "AbortError" })
  expect(owner.registry.collections.servers.get("private-b")).toBeUndefined()
  expect(owner.registry.serverListAuthority.get()).toBeNull()
  expect(screen.getByLabelText("B role")).toHaveTextContent("none")
}
it("keeps restored A intact when B business responses are available before the real delayed SDK confirms B", async () => {
  const owner = await cachedView()
  expect(authClient.$store.atoms.session.get().isPending).toBe(true)
  fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "local A draft" } })
  await assertBlocked(owner)
  expect(businessCalls()).toEqual([])
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("local A draft")
  await act(async () => releaseSession(sessionResponse("online-b")))
  await screen.findByText("online-b")
  await waitFor(() => expect(screen.getByLabelText("Server list")).toHaveTextContent("online-b server"))
  const b = owners.get("online-b")!.registry
  expect(b).not.toBe(owner.registry)
  expect(b.collections.servers.get("private-b")).toMatchObject({ ownerId: "online-b" })
  expect(b.serverListAuthority.get()).toMatchObject({ viewerId: "online-b" })
  expect(owner.registry.collections.servers.get("private-b")).toBeUndefined()
  await waitFor(() => expect(owner.registry.runtime.lifecycle.get().active).toBe(false))
})
it("keeps never-confirmed network failure local, resumes matching A, and retains A after later network failure", async () => {
  sessionMode = "offline"
  await act(async () => authClient.$store.atoms.session.get().refetch())
  const owner = await cachedView()
  expect(currentSessionViewer()).toBeUndefined()
  await assertBlocked(owner)
  expect(businessCalls()).toEqual([])
  const draft = screen.getByRole("textbox", { name: "Draft" })
  fireEvent.change(draft, { target: { value: "unsent A draft" } })
  sessionMode = "held"; businessUser = "cached-a"
  const baseline = sessionStarts
  let refresh!: Promise<void>
  act(() => { refresh = authClient.$store.atoms.session.get().refetch() })
  await waitFor(() => expect(sessionStarts).toBeGreaterThan(baseline))
  await act(async () => { releaseSession(sessionResponse("cached-a")); await refresh })
  await waitFor(() => expect(screen.getByLabelText("Server list")).toHaveTextContent("cached-a server"))
  expect(owners.get("cached-a")!.registry).toBe(owner.registry)
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft)
  expect(draft).toHaveValue("unsent A draft")
  expect(owner.registry.serverListAuthority.get()).toMatchObject({ viewerId: "cached-a" })
  sessionMode = "offline"
  await act(async () => authClient.$store.atoms.session.get().refetch())
  expect(currentSessionViewer()).toBeUndefined()
  expect(screen.getByLabelText("Server list")).toHaveTextContent("cached-a server")
  expect(draft).toHaveValue("unsent A draft")
  await act(async () => expect(await owner.createServer.mutateAsync({ name: "A local server name" })).toEqual({ server: { id: "created-a-server" } }))
  await runApplicationRequest(owner.application, options => apiFetch("/api/community/test-command", { ...options, method: "POST" }))
  expect(businessCalls().filter(([, options]) => (options as RequestInit).method === "POST")).toHaveLength(2)
})

it.each(["online-b", null])("rejects a previously admitted A response after the SDK viewer becomes %s", async nextViewer => {
  let viewer: string | null | undefined = "cached-a"
  const client = createQueryClient()
  const registry = createCommunityDbRegistry(client, "cached-a", { sessionViewer: () => viewer })
  registry.confirmAuthentication()
  await registry.preload()
  mounted = render(<CommunityTestProvider client={client} registry={registry}><input aria-label="Local draft" defaultValue="keep locally" /></CommunityTestProvider>)
  let release!: (response: Response) => void
  backend.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
  const pending = client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(client), retry: false })
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
  await waitFor(() => expect(release).toBeTypeOf("function"))
  viewer = nextViewer
  await act(async () => { release(response(rail("online-b"))); await rejected })
  expect(registry.collections.servers.get("private-b")).toBeUndefined()
  expect(registry.serverListAuthority.get()).toBeNull()
  expect(screen.getByRole("textbox", { name: "Local draft" })).toHaveValue("keep locally")
})
