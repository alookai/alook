import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { currentConversationReadState } from "@/lib/community/conversation-entry"
import { captureCommunityLiveSnapshotToken, ingestReadStateSnapshot, publishCommunityConversationReadState } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { dispatchCommunityWsEvent } from "./registry"
import type { CommunityWsDispatchContext } from "./handler-context"
import { notificationSettingsQueryFn } from "@/hooks/community/use-notification-settings"
import { disposeAccountReadStateReconciliation } from "./read-state-reconciliation"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
const emptyAttention = { scopes: [], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }
function context(): CommunityWsDispatchContext { return { deliveryMode: "single", queryClient: owner.client, communityStore: owner.runtime.ui, wsStore: owner.runtime.ws, sub: {}, viewerUserIdRef: { current: "u1" }, matchesFocus: () => false } }
beforeEach(async () => { owner = await createCommunityQueryOwner("u1"); apiFetch.mockReset() })
afterEach(async () => { disposeAccountReadStateReconciliation(owner.client); await owner.registry.cleanup(); owner.client.clear() })

it.each(["community:read_state.advanced", "community:inbox.changed"] as const)("fills the account snapshot after a confirmed read once for %s and ignores an old hint", async type => {
  const snapshot = { revision: 8, readStates: [
    { channelId: "c1", lastReadMessageId: "m8", lastReadAt: "2026-10-27T00:00:08.000Z", lastReadSeq: 8 },
    { channelId: "c2", lastReadMessageId: "m7", lastReadAt: "2026-10-27T00:00:07.000Z", lastReadSeq: 7 },
  ] }
  publishCommunityConversationReadState(owner.client, snapshot.readStates[0], 8, { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined })
  expect(owner.registry.collections.readStateClock.get("account")).toBeUndefined()
  apiFetch.mockImplementation(async (path: string) => path.endsWith("/read-state") ? snapshot : emptyAttention)
  const event = { type, revision: 8, inboxChanged: true, ...(type === "community:inbox.changed" ? { reason: "read_all" as const } : {}) }
  dispatchCommunityWsEvent(event, context())
  await vi.waitFor(() => expect(owner.registry.collections.readStateClock.get("account")?.revision).toBe(8))
  expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(8)
  expect(currentConversationReadState(owner.client, "c2")?.lastReadSeq).toBe(7)
  await vi.waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/attention"))).toHaveLength(1))
  dispatchCommunityWsEvent(event, context())
  expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/read-state"))).toHaveLength(1)
  expect(apiFetch.mock.calls.filter(([path]) => path.endsWith("/attention"))).toHaveLength(1)
  expect(apiFetch.mock.calls.some(([path]) => path === "/api/community/servers" || path.endsWith("/dms"))).toBe(false)
})

it("refreshes notification policy and invalidates native attention even after its read revision was observed", async () => {
  ingestReadStateSnapshot(owner.registry, { revision: 2, readStates: [] })
  owner.client.setQueryData(communityKeys.accountAttention(), { loaded: true })
  apiFetch.mockResolvedValue([{ serverId: "s1", channelId: null, level: "nothing" }])
  dispatchCommunityWsEvent({ type: "community:inbox.changed", revision: 2, inboxChanged: true, reason: "notification_policy" }, context())
  await vi.waitFor(() => expect(owner.registry.collections.notificationSettings.get("server:s1")?.level).toBe("nothing"))
  await vi.waitFor(() => expect(owner.client.getQueryState(communityKeys.accountAttention())?.isInvalidated).toBe(true))
  expect(apiFetch.mock.calls.map(([path]) => path)).toEqual(["/api/community/users/me/notifications"])
})

it("cancels an older policy transport and rejects its ignored-abort response", async () => {
  ingestReadStateSnapshot(owner.registry, { revision: 2, readStates: [] })
  let release!: (rows: unknown) => void, policyCalls = 0
  apiFetch.mockImplementation((path: string) => {
    if (path.endsWith("/notifications")) return ++policyCalls === 1 ? new Promise(done => { release = done }) : Promise.resolve([])
    return Promise.resolve(emptyAttention)
  })
  const old = owner.client.query({ queryKey: communityKeys.notificationSettings(), queryFn: notificationSettingsQueryFn }).catch(() => undefined)
  await vi.waitFor(() => expect(policyCalls).toBe(1))
  dispatchCommunityWsEvent({ type: "community:inbox.changed", revision: 2, inboxChanged: true, reason: "notification_policy" }, context())
  await vi.waitFor(() => expect(policyCalls).toBe(2))
  release([{ serverId: "s1", channelId: null, level: "nothing" }]); await old
  await vi.waitFor(() => expect(owner.client.getQueryData(communityKeys.notificationSettings())).toEqual({ ids: [] }))
  expect(owner.registry.collections.notificationSettings.size).toBe(0)
})
