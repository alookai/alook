import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, QueryClient, type QueryKey } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { useServers } from "../use-servers"
import { useFolders } from "../use-folders"
import { useServerRailCommit } from "./server-rail"
import { ServerRail } from "@/components/community/shell/server-rail"
import { tid } from "@/lib/community/testids"
import type { RailInstruction } from "@/lib/community/server-rail-model"
const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ session: { data: { user: { id: "A" } }, isPending: false, error: null } }))
const ui = vi.hoisted(() => ({ options: null as { onDrop: (instruction: RailInstruction) => void; canStart: () => boolean } | null, announce: vi.fn(), frames: [] as FrameRequestCallback[] }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => sdk.session }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@atlaskit/pragmatic-drag-and-drop-live-region", () => ({ announce: ui.announce, cleanup: vi.fn() }))
vi.mock("@/components/community/shell/use-server-rail-pdd", () => ({ useServerRailPdd: (options: typeof ui.options) => { ui.options = options; return { registerItem: vi.fn() } } }))
vi.mock("@/components/community/shell/sortable-server", () => ({ SortableServer: ({ server }: { server: { id: string; name: string } }) => <button data-testid={tid.serverIcon(server.id)}>{server.name}</button> }))
vi.mock("@/components/community/shell/rail-folder", () => ({ RailFolder: ({ folderId, open, onToggle, onUngroup }: { folderId: string; open: boolean; onToggle: () => void; onUngroup: () => void }) => <><button data-testid={tid.serverRailFolder(folderId)} aria-expanded={open} onClick={onToggle}>{folderId}</button><button onClick={onUngroup}>Ungroup {folderId}</button></> }))
vi.mock("@/components/community/shell/animated-alook-logo", () => ({ AnimatedAlookLogo: () => null }))
vi.mock("@/components/community/settings/create-server-dialog", () => ({ CreateServerDialog: () => null }))
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children, TooltipTrigger: ({ children }: { children: React.ReactNode }) => children, TooltipContent: () => null }))
const servers = ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), discriminator: "0001", ownerId: "A", role: "member", icon: null }))
const folders = [{ id: "one", name: "One", position: 0, servers: [{ id: "c", name: "C", icon: null }] }]
const before = { serverOrder: ["a", "b", "c"], folderOrder: ["one"], folders: { one: ["c"] }, expanded: [] }
const after = { serverOrder: ["b", "a", "c"], folderOrder: ["one", "temp"], folders: { one: ["c"], temp: ["a", "b"] }, expanded: ["temp"] }
const commands = [{ kind: "reorder-servers" as const, serverIds: after.serverOrder }, { kind: "create-folder" as const, clientId: "temp", name: "Group", serverIds: ["a", "b"] }]
let mutation: ReturnType<typeof useServerRailCommit>, qc: QueryClient
const clients: QueryClient[] = []
function Probe({ rail = false }: { rail?: boolean }) { const list = useServers(), groups = useFolders(); const command = useServerRailCommit(), client = useQueryClient(); useLayoutEffect(() => { mutation = command; qc = client; if (!clients.includes(client)) clients.push(client) }); return <><output data-testid="order">{list.servers.map((row) => row.id).join(",")}</output><output data-testid="names">{list.servers.map((row) => `${row.id}:${row.name}`).join(",")}</output><output data-testid="groups">{groups.folders.map((row) => `${row.id}:${row.servers.map((server) => server.id).join(",")}`).join("|")}</output>{rail && <ServerRail servers={list.servers} folders={groups.folders} view="server" onHome={vi.fn()} />}</> }
function Root({ id = "A", rail = false }: { id?: string; rail?: boolean }) { return <QueryProvider userId={id}><Probe rail={rail} /></QueryProvider> }
async function mount(rail = false) {
  let resolve!: (value: { createdFolderIds: Record<string, string> }) => void, reject!: (error: Error) => void
  const response = new Promise<{ createdFolderIds: Record<string, string> }>((done, fail) => { resolve = done; reject = fail })
  const seen = new Set<string>()
  api.mockImplementation((path: string, options: { method?: string; authenticationAccount?: string; signal?: AbortSignal }) => {
    if (options.method === "PATCH") return response
    const key = `${options.authenticationAccount}:${path}`
    if (seen.has(key)) return new Promise((_, fail) => options.signal?.addEventListener("abort", () => fail(new DOMException("Retired refresh", "AbortError")), { once: true }))
    seen.add(key); return Promise.resolve(path.endsWith("/server-folders") ? { folders } : { servers })
  })
  const view = render(<Root rail={rail} />)
  await waitFor(() => { expect(screen.getByTestId("order").textContent).toBe("a,b,c"); expect(screen.getByTestId("groups").textContent).toBe("one:c") })
  await getCommunityDbRegistry(qc)!.ready
  return { view, resolve, reject, original: qc }
}
function commit() { return mutation.mutateAsync({ before, after, commands }).catch((error: unknown) => error) }
beforeEach(async () => { await clearAllPersistedCaches(); sdk.session = { data: { user: { id: "A" } }, isPending: false, error: null }; ui.frames.length = 0; ui.announce.mockReset(); sessionStorage.clear(); vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { ui.frames.push(callback); return ui.frames.length }) })
afterEach(async () => {
  await act(async () => {
    api.mockReset(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals()
  })
})
describe("native canonical rail command owner", () => {
  it("stores folder IDs and publishes one multi-collection optimistic command batch with real ID confirmation", async () => {
    const { resolve, original } = await mount()
    expect(original.getQueryData(communityKeys.folders())).toEqual(["one"])
    const cancel = vi.spyOn(original, "cancelQueries")
    let result!: Promise<unknown>; act(() => { result = commit() })
    await waitFor(() => { expect(screen.getByTestId("order").textContent).toBe("b,a,c"); expect(screen.getByTestId("groups").textContent).toBe("one:c|temp:a,b") })
    const replacement = new QueryClient()
    for (const key of [communityKeys.servers(), communityKeys.folders()]) {
      const resource = original.getQueryCache().find({ queryKey: key, exact: true })!
      const filter = cancel.mock.calls.find(([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(key))?.[0]
      expect(filter).toMatchObject({ queryKey: key, exact: true, predicate: expect.any(Function) })
      expect(filter!.predicate!(resource)).toBe(true)
      expect(filter!.predicate!(replacement.getQueryCache().build<unknown, Error, unknown, QueryKey>(replacement, { queryKey: key }))).toBe(false)
    }
    replacement.clear()
    const patches = api.mock.calls.filter(([, options]) => options.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual(["/api/community/users/me/server-rail", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ commands }), authenticationAccount: "A" })])
    await act(async () => { resolve({ createdFolderIds: { temp: "real" } }); await result })
    await waitFor(() => expect(screen.getByTestId("groups").textContent).toBe("one:c|real:a,b"))
    const registry = getCommunityDbRegistry(original)!
    expect(registry.collections.folders.has("temp")).toBe(false); expect(registry.collections.folders.has("real")).toBe(true)
    expect([...registry.collections.folderItems.values()].some((row) => row.folderId === "temp")).toBe(false)
    expect(original.getQueryData(communityKeys.folders())).toEqual(["one"])
  })
  it("rolls back native topology while preserving a newer committed WS server name", async () => {
    const { reject, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = commit() })
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("b,a,c"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:server.update", serverId: "a", changes: { name: "newer" } }))
    await act(async () => { reject(new Error("denied")); expect(await result).toBeInstanceOf(Error) })
    await waitFor(() => { expect(screen.getByTestId("order").textContent).toBe("a,b,c"); expect(screen.getByTestId("groups").textContent).toBe("one:c") })
    expect(getCommunityDbRegistry(original)!.collections.servers.get("a")?.name).toBe("newer")
  })
  it("keeps confirmed server order and a newer WS name after successful settlement while refresh GETs remain held", async () => {
    const { resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = commit() })
    await waitFor(() => expect(screen.getByTestId("order").textContent).toBe("b,a,c"))
    act(() => projectCommunityWsEventToDb(original, { type: "community:server.update", serverId: "a", changes: { name: "newer" } }))
    const originalRegistry = getCommunityDbRegistry(original)!
    expect(original.getQueryData<Array<{ id: string; name: string }>>(
      communityKeys.communityDbCollection(originalRegistry.scopeId, "servers"),
    )?.find((row) => row.id === "a")?.name).toBe("newer")
    await act(async () => { resolve({ createdFolderIds: { temp: "real" } }); expect(await result).toEqual({ createdFolderIds: { temp: "real" } }) })
    await waitFor(() => expect(original.getQueryState(communityKeys.servers())?.fetchStatus).toBe("fetching"))
    expect(original.getQueryState(communityKeys.folders())?.fetchStatus).toBe("fetching")
    expect(screen.getByTestId("order").textContent).toBe("b,a,c")
    expect(screen.getByTestId("names").textContent).toBe("b:B,a:newer,c:C")
    const registry = getCommunityDbRegistry(original)!
    expect(registry.collections.servers.get("a")).toMatchObject({ name: "newer", position: 1 })
    expect(registry.collections.servers.get("b")?.position).toBe(0)
    expect(registry.collections.servers.get("c")?.position).toBe(2)
    const committed = original.getQueryData<Array<{ id: string; position: number; name: string }>>(
      communityKeys.communityDbCollection(registry.scopeId, "servers"),
    )
    expect(committed).toEqual(expect.arrayContaining([expect.objectContaining({ id: "a", name: "newer", position: 1 })]))
  })
  it("old successful account response cannot resurrect transport data or touch the new account", async () => {
    const { view, resolve, original } = await mount()
    let result!: Promise<unknown>; act(() => { result = commit() })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(true))
    act(() => { sdk.session = { data: { user: { id: "B" } }, isPending: false, error: null }; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(qc).not.toBe(original)); const current = qc
    await waitFor(() => expect(screen.getByTestId("groups").textContent).toBe("one:c"))
    await act(async () => { resolve({ createdFolderIds: { temp: "real" } }); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(original.getQueryCache().getAll()).toHaveLength(0)
    expect(getCommunityDbRegistry(current)!.collections.folders.has("real")).toBe(false)
  })
  it("actual ServerRail uses native pending, DB topology and preserves user collapse across confirmed ID mapping", async () => {
    const { resolve } = await mount(true)
    const drop = () => ui.options!.onDrop({ operation: "combine", source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, newFolderId: "temp" })
    act(() => { drop(); drop() })
    await waitFor(() => expect(api.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(1))
    expect(ui.options!.canStart()).toBe(false)
    const pending = await screen.findByTestId(tid.serverRailFolder("temp"))
    expect(pending.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(pending)
    await act(async () => resolve({ createdFolderIds: { temp: "real" } }))
    await waitFor(() => expect(screen.getByTestId(tid.serverRailFolder("real")).getAttribute("aria-expanded")).toBe("false"))
    await waitFor(() => expect(ui.options!.canStart()).toBe(true))
    expect(screen.queryByTestId(tid.serverRailFolder("temp"))).toBeNull()
  })
  it("successful old UI settles original DB facts without an announcement or focus continuation", async () => {
    const { view, resolve } = await mount(true)
    act(() => ui.options!.onDrop({ operation: "combine", source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, newFolderId: "temp" }))
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(true))
    act(() => view.rerender(<Root />)); ui.announce.mockClear(); ui.frames.length = 0
    await act(async () => resolve({ createdFolderIds: { temp: "real" } }))
    await waitFor(() => expect(screen.getByTestId("groups").textContent).toBe("one:c|real:a,b"))
    expect(ui.announce).not.toHaveBeenCalled(); expect(ui.frames).toHaveLength(0)
  })
  it("a queued original focus callback cannot focus the replacement account", async () => {
    const { view, resolve } = await mount(true)
    act(() => ui.options!.onDrop({ operation: "combine", source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, newFolderId: "temp" }))
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(true))
    await act(async () => resolve({ createdFolderIds: { temp: "real" } }))
    await waitFor(() => expect(ui.frames.length).toBeGreaterThan(0))
    act(() => { sdk.session = { data: { user: { id: "B" } }, isPending: false, error: null }; view.rerender(<Root id="B" rail />) })
    await waitFor(() => expect(screen.getByTestId("groups").textContent).toBe("one:c"))
    const query = vi.spyOn(document, "querySelector")
    await act(async () => { while (ui.frames.length) ui.frames.shift()!(0) })
    expect(query).not.toHaveBeenCalled(); query.mockRestore()
  })
})
