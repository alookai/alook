import "fake-indexeddb/auto"
import React from "react"
import { dehydrate, QueryClient, useIsRestoring } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { projectCommunityWsEventToDb } from "@/lib/community-db/sync"
import { CurrentUserProvider, useCurrentUser } from "@/contexts/community/current-user"
import { Avatar } from "@/components/community/avatar"
import { profileSchema } from "@/lib/community-db/schema"
import { communityKeys } from "@/lib/query-keys"
import { PERSIST_BUSTER, type QualifiedPersister } from "@/lib/query-persister"
import { useMachines } from "@/hooks/community/use-machines"
import { useServerMembers } from "@/hooks/community/use-server-members"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { useChannelMemberViewModel } from "@/components/community/members/channel-member-view-model"
import { useComposerController } from "@/components/community/messages/use-composer-controller"
import { CommunityMentionList } from "@/components/community/messages/composer-suggestion-popups"
import { EditorContent, type Editor } from "@tiptap/react"
const mocks = vi.hoisted(() => ({ restore: vi.fn(), api: vi.fn(),
  persistClient: vi.fn(async () => {}), removeClient: vi.fn(async () => {}), isCurrent: vi.fn(async () => true), retireAccount: vi.fn(async () => {}), retireChannels: vi.fn(async () => {}),
}))
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }), currentSessionViewer: () => "viewer" }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/channels/s1/c1", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => mocks.api(...args) }))
vi.mock("@/lib/query-persister", async original => ({ ...await original<typeof import("@/lib/query-persister")>(), createIdbPersister: () => ({ ...mocks, restoreClient: mocks.restore }) satisfies QualifiedPersister }))
import { QueryProvider } from "./QueryProvider"
let registry: CommunityDbRegistry
beforeEach(() => { localStorage.clear(); mocks.api.mockReset().mockRejectedValue(new Error("unexpected HTTP")); mocks.restore.mockReset().mockResolvedValue(undefined) })
describe("native client-entry consumers", () => {
  it.each([
    { diskVersion: 5, liveVersion: null, winner: 6 },
    { diskVersion: 7, liveVersion: null, winner: 7 },
    { diskVersion: 5, liveVersion: 8, winner: 8 },
  ])("preserves qualified avatar v$winner through disk restoration and live updates", async ({ diskVersion, liveVersion, winner }) => {
    const initial = { id: "viewer", name: "Session viewer", email: "viewer@example.test", discriminator: "0042", avatar: "/avatar?v=6", avatarVersion: 6 }
    const disk = new QueryClient()
    disk.setQueryData(communityKeys.communityDbCollection("viewer", "profiles"), [profileSchema.parse({ ...initial, identityComplete: true, avatar: `/avatar?v=${diskVersion}`, avatarVersion: diskVersion, aboutMe: "Cached about" })], { updatedAt: Date.now() - 10_000 })
    let release!: (value: unknown) => void
    mocks.restore.mockReturnValue(new Promise(resolve => { release = resolve }))
    let restoring = true
    function Self() {
      const self = useCurrentUser()
      const owned = useOptionalCommunityDbRegistry()!
      const pending = useIsRestoring()
      React.useLayoutEffect(() => { registry = owned; restoring = pending }, [owned, pending])
      return <section><output data-testid="avatar-version">{self.avatarVersion}</output><span data-testid="profile-about">{self.aboutMe}</span><Avatar label={self.avatar} seed={self.id} /></section>
    }
    const view = render(<QueryProvider userId="viewer" initialUser={initial}><CurrentUserProvider initialUser={initial}><Self /></CurrentUserProvider></QueryProvider>)
    try {
      await waitFor(() => expect(screen.getByTestId("avatar-version")).toHaveTextContent("6"))
      const image = view.container.querySelector("img")
      expect(image).toHaveAttribute("src", "/avatar?v=6")
      if (liveVersion) await act(async () => projectCommunityWsEventToDb(registry.queryClient, { type: "community:identity.update", userId: "viewer", avatar: `/avatar?v=${liveVersion}`, avatarVersion: liveVersion }))
      await act(async () => release({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(disk) }))
      await waitFor(() => expect(restoring).toBe(false))
      await waitFor(() => expect(screen.getByTestId("avatar-version")).toHaveTextContent(String(winner)))
      expect(view.container.querySelector("img")).toBe(image)
      expect(image).toHaveAttribute("src", `/avatar?v=${winner}`)
      expect(screen.getByTestId("profile-about")).toHaveTextContent("Cached about")
    } finally { release(undefined); view.unmount(); disk.clear() }
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
    const view = render(<QueryProvider userId="viewer"><Machines /></QueryProvider>)
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

  it.each([true, false])("connects real member search and popup after client entry when the directory starts ready=%s", async (serverReady) => {
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
    const tree = (ready: boolean) => <QueryProvider userId="viewer"><MemberComposer serverReady={ready} /></QueryProvider>
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

  it("releases real member and profile projections after native restore and allows mention search", async () => {
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
    const view = render(<QueryProvider userId="viewer"><Members /></QueryProvider>)
    await waitFor(() => expect(screen.getByTestId("members")).toHaveTextContent("John Doe"))
    await act(async () => members.searchMembers("John"))
    await waitFor(() => expect(members).toMatchObject({ searchStatus: "ready", loading: false, failed: false }))
    expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/members/search?q=John"), expect.anything())
    view.unmount()
  })

})
