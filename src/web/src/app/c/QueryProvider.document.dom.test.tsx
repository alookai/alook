import React from "react"
import { dehydrate, QueryClient, useIsRestoring } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { conversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { useCanonicalCommunityProfile, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER, type QualifiedPersister } from "@/lib/query-persister"
import { useMessages } from "@/hooks/community/use-messages"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"

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

const profile = { id: "viewer", name: "Server viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 7, aboutMe: "About", bannerColor: null, statusEmoji: null, statusText: "" }
const makeSeed = () => readCommunityDocumentSeed({} as Database, "viewer", "/c/channels/s1/c1", profile)
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
  mocks.viewer = "viewer"
  mocks.api.mockReset().mockRejectedValue(new Error("unexpected HTTP"))
  mocks.restore.mockReset().mockResolvedValue(undefined)
  mocks.door.mockReset().mockResolvedValue({ ok: true, value: { access: { channel: { serverId: "s1" } } } })
  mocks.entry.mockReset().mockResolvedValue({ ok: true, entry: conversationEntryFixture() })
})

describe("initial document seed in the actual native account provider", () => {
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

  it("rejects another viewer's document before the native DB hydrate call", async () => {
    const seed = await makeSeed()
    mocks.viewer = "other"
    function AccountProbe() { const owned = useOptionalCommunityDbRegistry()!; React.useLayoutEffect(() => { registry = owned }, [owned]); return null }
    const view = render(<QueryProvider userId="other" initialSeed={seed}><AccountProbe /></QueryProvider>)
    expect(registry.queryClient.getQueryData(communityKeys.selfProfile())).toBeUndefined()
    expect(registry.queryClient.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries("c1") })).toEqual([])
    expect(registry.collections.profiles.get("viewer")).toBeUndefined()
    view.unmount()
  })
})
