import "fake-indexeddb/auto"
import { createRequire } from "node:module"
import React, { Suspense } from "react"
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { dehydrate, QueryClient, useIsRestoring } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { conversationEntryFixture, dmConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { useCanonicalCommunityProfile, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER, type QualifiedPersister } from "@/lib/query-persister"
import { useDmMessages, useMessages } from "@/hooks/community/use-messages"
import { useMachines } from "@/hooks/community/use-machines"
import { useServerMembers } from "@/hooks/community/use-server-members"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useChannelMemberViewModel } from "@/components/community/members/channel-member-view-model"
import { useComposerController } from "@/components/community/messages/use-composer-controller"
import { CommunityMentionList } from "@/components/community/messages/composer-suggestion-popups"
import { EditorContent, type Editor } from "@tiptap/react"

const mocks = vi.hoisted(() => ({
  viewer: "viewer" as string | null, restore: vi.fn(), api: vi.fn(), door: vi.fn(), entry: vi.fn(),
  persistClient: vi.fn(async () => {}), removeClient: vi.fn(async () => {}),
  isCurrent: vi.fn(async () => true), retireAccount: vi.fn(async () => {}), retireChannels: vi.fn(async () => {}),
}))
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: mocks.viewer ? { user: { id: mocks.viewer } } : null, isPending: false, error: null }), currentSessionViewer: () => mocks.viewer }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/channels/s1/c1", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => mocks.api(...args) }))
vi.mock("@/lib/query-persister", async original => ({ ...await original<typeof import("@/lib/query-persister")>(), createIdbPersister: () => ({ ...mocks, restoreClient: mocks.restore }) satisfies QualifiedPersister }))
vi.mock("@/lib/community/message-door", () => ({ resolveMessageTarget: mocks.door }))
vi.mock("@/lib/community/conversation-entry.server", () => ({ readCommunityConversationEntry: mocks.entry }))
import { readCommunityDocumentSeed } from "@/lib/community/document-seed.server"
import type { Database } from "@alook/shared"
import { QueryProvider } from "./QueryProvider"
import { installCommunityDocumentSeed, type CommunityDocumentSeed } from "@/lib/community/document-seed"
import { Message } from "@/components/community/messages/message"
import { Avatar } from "@/components/community/avatar"
import { CurrentUserProvider, useCurrentUser } from "@/contexts/community/current-user"
import { profileSchema } from "@/lib/community-db/schema"

const profile = { id: "viewer", name: "Server viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 7, aboutMe: "About", bannerColor: null, statusEmoji: null, statusText: "" }
const makeSeed = () => readCommunityDocumentSeed({} as Database, "viewer", "/c/channels/s1/c1", profile)
const { createFromReadableStream } = createRequire(import.meta.url)("next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.edge.production.js") as {
  createFromReadableStream<T>(stream: ReadableStream<Uint8Array>, options: { serverConsumerManifest: { moduleMap: object; serverModuleMap: object; moduleLoading: null } }): Promise<T>
}
function flightSeed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const promise = createFromReadableStream<CommunityDocumentSeed | null>(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), {
    serverConsumerManifest: { moduleMap: {}, serverModuleMap: {}, moduleLoading: null },
  })
  return {
    promise,
    resolve(seed: CommunityDocumentSeed | null) { controller.enqueue(new TextEncoder().encode(`0:${JSON.stringify(seed)}\n`)); controller.close() },
    reject(error: Error) { controller.error(error) },
  }
}
let registry: CommunityDbRegistry
let restoring: boolean
function Probe() {
  const owned = useOptionalCommunityDbRegistry()!
  const phase = useIsRestoring()
  React.useLayoutEffect(() => { registry = owned; restoring = phase }, [owned, phase])
  const self = useCanonicalCommunityProfile("viewer")
  const feed = useMessages("c1", { serverId: "s1", viewerUserId: "viewer" })
  return <span data-testid="main">{`${self?.name}:${feed.isLoading ? "loading" : feed.messages.map(message => message.content).join("|")}`}</span>
}
beforeEach(() => {
  localStorage.clear()
  mocks.viewer = "viewer"
  mocks.api.mockReset().mockRejectedValue(new Error("unexpected HTTP"))
  mocks.restore.mockReset().mockResolvedValue(undefined)
  mocks.door.mockReset().mockResolvedValue({ ok: true, value: { access: { channel: { serverId: "s1" } } } })
  mocks.entry.mockReset().mockResolvedValue({ ok: true, entry: conversationEntryFixture() })
})

describe("initial document seed in the actual native account provider", () => {
  it.each([
    { kind: "optional failure", diskVersion: 5, winner: 6 },
    { kind: "late seed", diskVersion: 5, winner: 6 },
    { kind: "newer disk", diskVersion: 7, winner: 7 },
    { kind: "early seed", diskVersion: 7, winner: 7 },
    { kind: "newer WS", diskVersion: 5, winner: 8 },
  ])("preserves the qualified avatar across restoration and $kind while business seed waits", async ({ kind, diskVersion, winner }) => {
    const initial = { ...profile, avatar: "/avatar?v=6", avatarVersion: 6 }
    const currentUser = { ...initial, email: "viewer@example.test" }
    const seed = await readCommunityDocumentSeed({} as Database, "viewer", null, initial)
    let releaseSeed!: (value: CommunityDocumentSeed | null) => void
    const pending = new Promise<CommunityDocumentSeed | null>(resolve => { releaseSeed = resolve })
    const disk = new QueryClient()
    disk.setQueryData(communityKeys.communityDbCollection("viewer", "profiles"), [profileSchema.parse({ ...initial, identityComplete: true, avatar: `/avatar?v=${diskVersion}`, avatarVersion: diskVersion, aboutMe: "Cached about" })], { updatedAt: Date.now() - 10_000 })
    let releaseRestore!: (value: unknown) => void
    mocks.restore.mockReturnValue(new Promise(resolve => { releaseRestore = resolve }))
    const capture = vi.fn<(registry: CommunityDbRegistry, restoring: boolean) => void>()
    function Self() {
      const self = useCurrentUser()
      capture(useOptionalCommunityDbRegistry()!, useIsRestoring())
      return <section><output data-testid="avatar-version">{self.avatarVersion}</output><span data-testid="profile-about">{self.aboutMe}</span><Avatar label={self.avatar} seed={self.id} /></section>
    }
    let view!: ReturnType<typeof render>
    try {
      await act(async () => { view = render(<QueryProvider userId="viewer" initialUser={currentUser} initialSeed={pending}><CurrentUserProvider initialUser={currentUser}><Self /></CurrentUserProvider></QueryProvider>) })
      await waitFor(() => expect(screen.getByTestId("avatar-version")).toHaveTextContent("6"))
      const output = screen.getByTestId("avatar-version")
      const image = view.container.querySelector("img")
      expect(image).toHaveAttribute("src", "/avatar?v=6")
      if (kind === "early seed") await act(async () => { installCommunityDocumentSeed(capture.mock.lastCall![0].queryClient, capture.mock.lastCall![0], seed, "viewer") })
      if (kind === "newer WS") await act(async () => { projectCommunityWsEventToDb(capture.mock.lastCall![0].queryClient, { type: "community:identity.update", userId: "viewer", avatar: "/avatar?v=8", avatarVersion: 8 }) })
      await act(async () => { releaseRestore({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(disk) }) })
      await waitFor(() => expect(capture.mock.lastCall![1]).toBe(false))
      const canonical = () => capture.mock.lastCall![0].queryClient.getQueryData<Array<{ id: string; avatarVersion?: number; avatar?: string | null }>>(communityKeys.communityDbCollection("viewer", "profiles"))?.find(row => row.id === "viewer")
      expect(canonical()).toMatchObject({ avatarVersion: winner, avatar: `/avatar?v=${winner}` })
      expect(output).toHaveTextContent(String(winner))
      expect(image).toHaveAttribute("src", `/avatar?v=${winner}`)
      expect(screen.getByTestId("profile-about")).toHaveTextContent("Cached about")
      await act(async () => { releaseSeed(kind === "optional failure" ? null : seed); await pending })
      expect(canonical()).toMatchObject({ avatarVersion: winner, avatar: `/avatar?v=${winner}` })
      expect(screen.getByTestId("avatar-version")).toBe(output)
      expect(view.container.querySelector("img")).toBe(image)
      expect(output).toHaveTextContent(String(winner))
      expect(image).toHaveAttribute("src", `/avatar?v=${winner}`)
    } finally {
      releaseSeed(null)
      await act(async () => { await pending; view?.unmount() })
      disk.clear()
    }
  })

  it.each([false, true])("accepts the production Flight thenable when already fulfilled=%s", async (fulfilled) => {
    const seed = await makeSeed()
    mocks.api.mockImplementation(() => new Promise(() => {}))
    const flight = flightSeed()
    expect(flight.promise.then(vi.fn(), vi.fn())).toBeUndefined()
    if (fulfilled) { flight.resolve(seed); await Promise.resolve(flight.promise) }
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={flight.promise}><Probe /></QueryProvider>) })
    try {
      await waitFor(() => expect(restoring).toBe(false))
      if (!fulfilled) {
        expect(screen.getByTestId("main")).toHaveTextContent("loading")
        await act(async () => { flight.resolve(seed); await Promise.resolve(flight.promise) })
      }
      await waitFor(() => expect(screen.getByTestId("main")).toHaveTextContent("Server viewer:Body"))
    } finally { await act(async () => { view.unmount() }) }
  })

  it.each([false, true])("handles a rejected Flight seed with cancelled=%s and keeps its cache consumer mounted", async (cancelled) => {
    const flight = flightSeed()
    const error = cancelled ? new DOMException("Flight seed cancelled", "AbortError") : new Error("Flight seed unavailable")
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={flight.promise}><Probe /></QueryProvider>) })
    try {
      await act(async () => { flight.reject(error); await Promise.resolve(flight.promise).catch(() => {}) })
      if (cancelled) expect(logged).not.toHaveBeenCalled()
      else await waitFor(() => expect(logged).toHaveBeenCalledWith("Community document seed installation failed", error))
      expect(screen.getByTestId("main")).toBeInTheDocument()
    } finally { await act(async () => { view.unmount() }); logged.mockRestore() }
  })

  it.each(["resolve", "reject"] as const)("ignores a Flight %s after the account provider unmounts", async (settlement) => {
    const seed = await makeSeed()
    const flight = flightSeed()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={flight.promise}><Probe /></QueryProvider>) })
    await waitFor(() => expect(restoring).toBe(false))
    const owned = registry
    await act(async () => { view.unmount() })
    const hydrate = vi.spyOn(owned.dbClient, "hydrate")
    try {
      await act(async () => {
        if (settlement === "resolve") flight.resolve(seed)
        else flight.reject(new Error("Retired Flight"))
        await Promise.resolve(flight.promise).catch(() => {})
      })
      expect(hydrate).not.toHaveBeenCalled()
      expect(logged).not.toHaveBeenCalled()
      expect(owned.queryClient.getQueryData(communityKeys.selfProfile())).toBeUndefined()
    } finally { logged.mockRestore() }
  })

  it("catches an installation exception after a Flight seed resolves", async () => {
    const seed = await makeSeed()
    const flight = flightSeed()
    const error = new Error("Profile installation failed")
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    flight.promise.then((value) => { Object.defineProperty(value!, "selfProfile", { get() { throw error } }) })
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={flight.promise}><Probe /></QueryProvider>) })
    try {
      await act(async () => { flight.resolve(seed); await Promise.resolve(flight.promise) })
      await waitFor(() => expect(logged).toHaveBeenCalledWith("Community document seed installation failed", error))
      expect(screen.getByTestId("main")).toBeInTheDocument()
    } finally { await act(async () => { view.unmount() }); logged.mockRestore() }
  })

  it("hydrates the native SSR snapshot and canonical author through fulfilled Flight input", async () => {
    mocks.door.mockResolvedValue({ ok: true, value: { access: { channel: { serverId: null } } } })
    mocks.entry.mockResolvedValue({ ok: true, entry: dmConversationEntryFixture() })
    mocks.api.mockImplementation(() => new Promise(() => {}))
    const seed = await readCommunityDocumentSeed({} as Database, "viewer", "/c/me/c1", profile)
    const flight = flightSeed()
    flight.resolve(seed)
    await Promise.resolve(flight.promise)
    const captureRegistry = vi.fn<(registry: CommunityDbRegistry) => void>()
    function DmBody() {
      captureRegistry(useOptionalCommunityDbRegistry()!)
      const feed = useDmMessages("c1", { viewerUserId: "viewer" })
      return <main>{feed.isLoading ? "Loading DM" : feed.messages.map(message => <Message key={message.id} m={{ ...message, grouped: false }} onOpenThread={() => {}} />)}</main>
    }
    const html = renderToString(<QueryProvider userId="viewer" initialSeed={seed}><Suspense fallback={null}><DmBody /></Suspense></QueryProvider>)
    const serverOwner = captureRegistry.mock.lastCall![0]
    await serverOwner.cleanup()
    serverOwner.queryClient.clear()
    const tree = <QueryProvider userId="viewer" initialSeed={flight.promise}><DmBody /></QueryProvider>
    const container = document.createElement("div")
    container.innerHTML = html
    document.body.appendChild(container)
    const row = container.querySelector("[data-message-author-line]")
    expect(row).toHaveTextContent("Peer")
    expect(container.textContent).not.toContain("Loading DM")
    expect(container.textContent).not.toContain("Deleted user")
    const recoveries: unknown[] = []
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    let root!: ReturnType<typeof hydrateRoot>
    try {
      await act(async () => { root = hydrateRoot(container, tree, { onRecoverableError: error => { recoveries.push(error) } }) })
      await waitFor(() => expect(container.querySelector("[data-message-author-line]")).toHaveTextContent("Peer"))
      expect(container.textContent).not.toContain("Deleted user")
      expect({ same: container.querySelector("[data-message-author-line]") === row, recoveries: recoveries.map(String), errors: logged.mock.calls }).toEqual({ same: true, recoveries: [], errors: [] })
    } finally { await act(async () => { root?.unmount() }); container.remove(); logged.mockRestore() }
  })

  it("mounts the consumer before deferred seed and fills its missing entry after restore", async () => {
    const seed = await makeSeed()
    mocks.api.mockImplementation(() => new Promise(() => {}))
    let release!: (value: CommunityDocumentSeed) => void
    const pending = new Promise<CommunityDocumentSeed>(resolve => { release = resolve })
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={pending}><Probe /></QueryProvider>) })
    await waitFor(() => expect(restoring).toBe(false))
    expect(screen.getByTestId("main")).toHaveTextContent("loading")
    const mounted = screen.getByTestId("main")
    const hydrate = vi.spyOn(registry.dbClient, "hydrate")
    await act(async () => { release(seed); await pending })
    await waitFor(() => expect(screen.getByTestId("main")).toHaveTextContent("Server viewer:Body"))
    expect(screen.getByTestId("main")).toBe(mounted)
    expect(hydrate).not.toHaveBeenCalled()
    view.unmount()
  })

  it("keeps newer canonical content and an existing entry when deferred seed arrives", async () => {
    const seed = await makeSeed()
    mocks.api.mockImplementation(() => new Promise(() => {}))
    let release!: (value: CommunityDocumentSeed) => void
    const pending = new Promise<CommunityDocumentSeed>(resolve => { release = resolve })
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={pending}><Probe /></QueryProvider>) })
    await waitFor(() => expect(restoring).toBe(false))
    await act(async () => { installCommunityDocumentSeed(registry.queryClient, registry, seed, "viewer") })
    await waitFor(() => expect(screen.getByTestId("main")).toHaveTextContent("Body"))
    const entry = registry.queryClient.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") }).find(query => query.state.data)
    const resource = entry?.state.data
    const hydrate = vi.spyOn(registry.dbClient, "hydrate")
    await act(async () => projectCommunityWsEventToDb(registry.queryClient, { type: "community:message.edited", serverId: "s1", channelId: "c1", messageId: "m1", content: "New WS content" }))
    await act(async () => { release(seed); await pending })
    await waitFor(() => expect(screen.getByTestId("main")).toHaveTextContent("New WS content"))
    expect(entry?.state.data).toBe(resource)
    expect(hydrate).not.toHaveBeenCalled()
    view.unmount()
  })

  it("does not re-grant revoked access from a deferred document", async () => {
    const seed = await makeSeed()
    mocks.api.mockImplementation(() => new Promise(() => {}))
    let release!: (value: CommunityDocumentSeed) => void
    const pending = new Promise<CommunityDocumentSeed>(resolve => { release = resolve })
    let view!: ReturnType<typeof render>
    await act(async () => { view = render(<QueryProvider userId="viewer" initialSeed={pending}><Probe /></QueryProvider>) })
    await waitFor(() => expect(restoring).toBe(false))
    await act(async () => { registry.runtime.ws.actions.revokeChannelAccess("s1", "c1") })
    await act(async () => { release(seed); await pending })
    expect(registry.runtime.ws.actions.isChannelAccessRevoked("c1", "s1")).toBe(true)
    expect(screen.getByTestId("main")).not.toHaveTextContent("Body")
    view.unmount()
  })

  it("hydrates the persisted machine list into an already mounted native query while live list waits", async () => {
    const actual = await vi.importActual<typeof import("@/lib/query-persister")>("@/lib/query-persister")
    const disk = new QueryClient()
    const machine = { id: "machine", hostname: "Restored host", displayName: "Computer", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "1", createdAt: "created", updatedAt: "updated", status: "online" }
    disk.setQueryData(communityKeys.machines(), { machines: [machine] }, { updatedAt: 1000 })
    const persister = actual.createIdbPersister("viewer-machine-roundtrip")
    await persister.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(disk) })
    const stored = await persister.restoreClient()
    expect(stored!.clientState.queries[0].state.data).toMatchObject({ machines: [{ hostname: "Restored host" }] })
    mocks.restore.mockResolvedValue(stored)
    let release!: (value: unknown) => void
    const liveList = new Promise(resolve => { release = resolve })
    mocks.api.mockImplementation((url: string) => url.endsWith("view=list") ? liveList : Promise.resolve({ quotas: [], machineCapacity: { ownedCount: 1, onlineCount: 0 } }))
    let current!: ReturnType<typeof useMachines>
    function Machines() {
      const data = useMachines()
      React.useLayoutEffect(() => { current = data }, [data])
      return <span data-testid="machines">{data.machines.map(row => row.hostname).join("|")}</span>
    }
    const seed = await makeSeed()
    const view = render(<QueryProvider userId="viewer" initialSeed={seed}><Machines /></QueryProvider>)
    try {
      await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("view=observations"), expect.anything()))
      await waitFor(() => expect(screen.getByTestId("machines")).toHaveTextContent("Restored host"))
      expect(current.data?.machines[0].status).toBeUndefined()
      expect(current.data?.machineCapacity).toBeUndefined()
      await act(async () => release({ machines: [{ ...machine, status: "offline" }] }))
      await waitFor(() => expect(current.data?.machines[0].status).toBe("offline"))
    } finally {
      release({ machines: [] })
      view.unmount()
      await persister.removeClient()
      disk.clear()
    }
  })

  it.each([true, false])("connects real member search and popup after RSC when the directory starts ready=%s", async (serverReady) => {
    const seed = await makeSeed()
    const person = { id: "member-peer", userId: "peer", name: "John Doe", discriminator: "0042", avatar: "J", avatarVersion: 0, role: "member", status: "offline", sub: "" }
    mocks.api.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/community/servers/s1/members")) return { members: [person], hasMore: false, limit: 50, total: 1 }
      if (url === "/api/community/servers") return { servers: [] }
      throw new Error(`Unexpected resource ${url}`)
    })
    let editor: Editor | null = null
    function MemberComposer({ serverReady }: { serverReady: boolean }) {
      const members = useChannelMemberViewModel({ serverId: "s1", channelId: "c1", channelName: "Channel", currentServer: serverReady ? { categories: [{ channels: [{ id: "c1", type: "text" }] }] } : null, channelInServer: { creatorId: "viewer" }, currentChannelMeta: null, isChildChannel: false, isNotifyUnit: false, currentUser: { id: "viewer" } })
      const view = useComposerController({ channel: "Channel", context: "channel", draftKey: "rsc-members", members: members.composerMembers, mentionCandidates: members.composerMentionCandidates, sendContract: "accepted", onAcceptSend: () => true, hideAttach: true, hideEmoji: true }, null)
      React.useLayoutEffect(() => { editor = view.editor }, [view.editor])
      return <><EditorContent editor={view.editor} /><CommunityMentionList state={view.mentionPopup} presentation={view.mentionPresentation} /></>
    }
    const rect = new DOMRect(10, 20, 1, 18)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect })
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [rect] })
    const tree = (ready: boolean) => <QueryProvider userId="viewer" initialSeed={seed}><MemberComposer serverReady={ready} /></QueryProvider>
    const view = render(tree(serverReady))
    try {
      await waitFor(() => expect(editor).not.toBeNull())
      await act(async () => { editor!.view.dom.focus(); editor!.commands.insertContent("@") })
      if (!serverReady) await act(async () => { view.rerender(tree(true)) })
      await act(async () => { for (const char of "John") editor!.commands.insertContent(char) })
      await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/members/search?q=John"), expect.anything()))
      await waitFor(() => expect(screen.getByTestId("community-mention-option-member-peer")).toBeVisible())
      const originalEditor = editor
      await act(async () => { view.rerender(tree(false)) })
      await act(async () => { view.rerender(tree(true)) })
      expect(editor).toBe(originalEditor)
      expect(editor!.getText()).toBe("@John")
      await waitFor(() => expect(screen.getByTestId("community-mention-option-member-peer")).toBeVisible())
    } finally {
      view.unmount()
      delete (Range.prototype as Partial<Range>).getBoundingClientRect
      delete (Range.prototype as Partial<Range>).getClientRects
    }
  })

  it("releases real member and profile projections after the document handoff and allows mention search", async () => {
    const seed = await makeSeed()
    const person = { id: "member-peer", userId: "peer", name: "John Doe", discriminator: "0042", avatar: "J", avatarVersion: 0, role: "member", status: "offline", sub: "" }
    mocks.api.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/community/servers/s1/members")) return { members: [person], hasMore: false, limit: 50, total: 1 }
      throw new Error(`Unexpected resource ${url}`)
    })
    let members!: ReturnType<typeof useServerMembers>
    function Members() {
      const owned = useOptionalCommunityDbRegistry()!
      const result = useServerMembers("s1")
      React.useLayoutEffect(() => { registry = owned; members = result }, [owned, result])
      return <span data-testid="members">{result.loading ? "pending" : result.failed ? "failed" : result.members.map(member => member.name).join("|")}</span>
    }
    const view = render(<QueryProvider userId="viewer" initialSeed={seed}><Members /></QueryProvider>)
    await waitFor(() => expect(screen.getByTestId("members")).toHaveTextContent("John Doe"))
    await act(async () => members.searchMembers("John"))
    await waitFor(() => expect(members).toMatchObject({ searchStatus: "ready", loading: false, failed: false }))
    expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/members/search?q=John"), expect.anything())
    view.unmount()
  })

  it("paints the real message hook before disk completes, then preserves fresh WS facts over old disk", async () => {
    const seed = await makeSeed()
    let release!: (value: unknown) => void
    mocks.restore.mockReturnValue(new Promise(resolve => { release = resolve }))
    const view = render(<QueryProvider userId="viewer" initialSeed={seed}><Probe /></QueryProvider>)
    expect(screen.getByTestId("main")).toHaveTextContent("Server viewer:Body")
    expect(restoring).toBe(true)
    expect(mocks.api).not.toHaveBeenCalled()
    await act(async () => projectCommunityWsEventToDb(registry.queryClient, { type: "community:message.edited", serverId: "s1", channelId: "c1", messageId: "m1", content: "WS body" }))
    const disk = new QueryClient()
    disk.setQueryData(communityKeys.communityDbCollection("viewer", "profiles"), [{ ...profile, name: "Old disk", identityComplete: true }], { updatedAt: 1 })
    disk.setQueryData(communityKeys.communityDbCollection("viewer", "messages"), [{ ...conversationEntryFixture().messages[0], content: "Old disk body", resourceComplete: true }], { updatedAt: 1 })
    await act(async () => release({ buster: PERSIST_BUSTER, timestamp: Date.now(), clientState: dehydrate(disk) }))
    await waitFor(() => expect(restoring).toBe(false))
    await waitFor(() => expect(screen.getByTestId("main")).toHaveTextContent("Server viewer:WS body"))
    expect(registry.hasRestoredCollection("messages")).toBe(true)
    expect(registry.hasRestoredCollection("channels")).toBe(false)
    expect(mocks.api).not.toHaveBeenCalled()
    view.unmount()
    await waitFor(() => expect(registry.collections.messages.status).toBe("cleaned-up"))
    disk.clear()
  })

  it("ignores later refresh seeds before hydrate after the initial owner has advanced or revoked access", async () => {
    const seed = await makeSeed()
    const view = render(<QueryProvider userId="viewer" initialSeed={seed}><Probe /></QueryProvider>)
    await waitFor(() => expect(restoring).toBe(false))
    await act(async () => { await registry.preload() })
    const hydrate = vi.spyOn(registry.dbClient, "hydrate")
    await act(async () => projectCommunityWsEventToDb(registry.queryClient, { type: "community:message.edited", serverId: "s1", channelId: "c1", messageId: "m1", content: "Current WS" }))
    await waitFor(() => expect(screen.getByTestId("main")).toHaveTextContent("Current WS"))
    view.rerender(<QueryProvider userId="viewer" initialSeed={JSON.parse(JSON.stringify(seed))}><Probe /></QueryProvider>)
    expect(hydrate).not.toHaveBeenCalled()
    expect(screen.getByTestId("main")).toHaveTextContent("Current WS")
    await act(async () => { registry.runtime.ws.actions.revokeChannelAccess("s1", "c1") })
    view.rerender(<QueryProvider userId="viewer" initialSeed={seed}><Probe /></QueryProvider>)
    expect(hydrate).not.toHaveBeenCalled()
    expect(registry.runtime.ws.actions.isChannelAccessRevoked("c1", "s1")).toBe(true)
    expect(screen.getByTestId("main")).not.toHaveTextContent("Current WS")
    view.unmount()
  })

  it.each([false, true])("rejects another viewer's document before native DB hydrate with Flight=%s", async (deferred) => {
    const seed = await makeSeed()
    const flight = flightSeed()
    mocks.viewer = "other"
    function AccountProbe() { const owned = useOptionalCommunityDbRegistry()!; React.useLayoutEffect(() => { registry = owned }, [owned]); return null }
    const view = render(<QueryProvider userId="other" initialSeed={deferred ? flight.promise : seed}><AccountProbe /></QueryProvider>)
    await act(async () => { flight.resolve(seed); await Promise.resolve(flight.promise) })
    expect(registry.queryClient.getQueryData(communityKeys.selfProfile())).toBeUndefined()
    expect(registry.queryClient.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") })).toEqual([])
    expect(registry.collections.profiles.get("viewer")).toBeUndefined()
    view.unmount()
  })
})
