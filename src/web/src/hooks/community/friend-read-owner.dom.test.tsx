import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQuery, useInfiniteQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useFriends, useFriendsPresence } from "./use-friends"
import { useBots } from "./use-bots"
import { usePresence } from "./use-server-panels"
import { useChannelMembers, useAddableMembers } from "./use-channel-members"
import { useInvitableFriends } from "./use-invitable-friends"
import { userProfileQueryFn } from "./use-user-profile"
import { membersPageQueryFn } from "./use-server-members"
import { useReactionDetails } from "./use-reaction-details"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: "A" } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let client: QueryClient
function Friends() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useFriends(); return null }
function Presence() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useFriendsPresence(); return null }
const probes = {
  friends: Friends,
  presence: Presence,
  bots: function Bots() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useBots(); return null },
  serverPresence: function ServerPresence() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); usePresence("server"); return null },
  channelMembers: function ChannelMembers() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useChannelMembers("channel", true, "server"); return null },
  addableMembers: function AddableMembers() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useAddableMembers("server", "channel"); return null },
  invitableFriends: function InvitableFriends() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useInvitableFriends("server"); return null },
  userProfile: function UserProfile() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useQuery({ queryKey: ["profile", "peer"], queryFn: userProfileQueryFn("peer") }); return null },
  serverMembers: function ServerMembers() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useInfiniteQuery({ queryKey: ["members", "server"], queryFn: membersPageQueryFn("server"), initialPageParam: null, getNextPageParam: () => undefined }); return null },
  reactions: function Reactions() { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); useReactionDetails({ messageId: "message", open: true, userIds: [] }); return null },
}
type Kind = keyof typeof probes
const kinds = Object.keys(probes) as Kind[]
function Root({ kind, consumers = 2 }: { kind: Kind; consumers?: number }) { const Probe = probes[kind]; return <QueryProvider userId="A">{Array.from({ length: consumers }, (_, index) => <Probe key={index} />)}</QueryProvider> }
const peer = { id: "peer", userId: "peer", name: "Late Peer", discriminator: "0001", avatar: "", avatarVersion: 0, status: "offline", sub: "" }
function response(path: string) {
  if (path.endsWith("accepted")) return { friends: [{ ...peer, id: "friendship" }] }
  if (path.endsWith("blocked")) return { blocked: [] }
  if (path.endsWith("pending")) return { pending: [] }
  if (path.endsWith("presence")) return { online: ["peer"] }
  if (path.endsWith("/bots")) return { bots: [{ ...peer, image: "", presence: "online" }] }
  if (path.includes("/channels/") && path.endsWith("/members")) return { members: [peer] }
  if (path.includes("/members")) return { members: [peer], hasMore: false, total: 1 }
  if (path.endsWith("/profile")) return { ...peer, image: "", kind: "human", aboutMe: "", bannerColor: null, mutualServers: 0, statusEmoji: null, statusText: null }
  if (path.endsWith("/reactions")) return { messageId: "message", scope: { kind: "server", serverId: "server", channelId: "channel" }, actors: [{ userId: "peer", profile: peer }] }
  throw new Error(`unexpected path ${path}`)
}
function requestCount(kind: Kind) { return kind === "invitableFriends" ? 4 : kind === "friends" ? 3 : kind === "addableMembers" ? 2 : 1 }
beforeEach(async () => { await clearAllPersistedCaches(); api.mockReset() })
describe("actual shared friend read ownership", () => {
  it.each(kinds)("%s keeps shared IO for one observer, aborts at zero, and rejects late profile publication", async (kind) => {
    const requests: Array<{ path: string; signal?: AbortSignal; resolve: (value: unknown) => void }> = []
    api.mockImplementation((path: string, options: { signal?: AbortSignal }) => new Promise((resolve) => { requests.push({ path, signal: options.signal, resolve }) }))
    const view = render(<Root kind={kind} />)
    await waitFor(() => expect(requests).toHaveLength(requestCount(kind)))
    const original = client, registry = getCommunityDbRegistry(original)!
    await act(async () => { await registry.ready; await registry.preload() })
    for (const request of requests) expect(request.signal).toBeInstanceOf(AbortSignal)
    act(() => view.rerender(<Root kind={kind} consumers={1} />))
    expect(requests.every((request) => !request.signal!.aborted)).toBe(true)
    expect(api).toHaveBeenCalledTimes(requestCount(kind))
    act(() => view.rerender(<Root kind={kind} consumers={0} />))
    await waitFor(() => expect(requests.every((request) => request.signal!.aborted)).toBe(true))
    expect(registry.runtime.lifecycle.get().active).toBe(true)
    await act(async () => {
      for (const request of requests) request.resolve(response(request.path))
      await new Promise((done) => setTimeout(done, 0))
    })
    expect(registry.collections.profiles.has("peer")).toBe(false)
    expect(registry.runtime.ws.get().presenceByUserId.has("peer")).toBe(false)
  })
})
