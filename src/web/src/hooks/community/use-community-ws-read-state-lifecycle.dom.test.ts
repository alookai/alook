import { getCapturedRuntime } from "./community-ws/test-harness"
import { act } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
  canonicalRegistry,
  capturedOnMessage,
  capturedQueryClient,
  capturedUseUserWsOptions,
  cleanupCommunityWsHarness,
  flushEffects,
  getCommunityApiFetchMock,
  mountHook,
  resetCommunityWsHarness,
  unmountHook,
} from "./community-ws/test-harness"
import { seedCommunityAttentionScope } from "@/test/community-query-owner"
import { registerReadSurface, releaseReadSurface, submitReadIntent } from "./read-coordinator"

const emptyAttention = { scopes: [], items: [], limit: 50, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }
const attentionCalls = () => getCommunityApiFetchMock().mock.calls.filter(([path]) => path === "/api/community/users/me/attention")
beforeEach(async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  await resetCommunityWsHarness()
})
afterEach(async () => { await cleanupCommunityWsHarness(); vi.unstubAllGlobals() })

describe("community read-state lifecycle reconciliation", () => {
  it("settles admitted reading through its account owner after the WS hook unmounts without old structural fallback", async () => {
    vi.useFakeTimers()
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch-1" })
    await mountHook({ viewerUserId: "viewer-1" })
    flushEffects()
    seedCommunityAttentionScope(capturedQueryClient, { channelId: "ch-1", serverId: "s1", seq: 1 })
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
      if (typeof url === "string" && url.endsWith("/read")) { await readGate; return { changed: true, revision: 1, targetSeq: 1 } }
      if (url === "/api/community/users/me/read-state") {
        expect(canonicalRegistry!.collections.readStates.get("ch-1")).toMatchObject({ lastReadMessageId: "message-1", lastReadSeq: 1, observedRevision: 1 })
        return { revision: 1, readStates: [{ channelId: "ch-1", lastReadMessageId: "message-1", lastReadAt: "2026-08-27T00:00:00.000Z", lastReadSeq: 1 }] }
      }
      if (url === "/api/community/users/me/attention") return emptyAttention
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const lease = registerReadSurface(capturedQueryClient, "viewer-1", { kind: "timeline", channelId: "ch-1" })
    try {
      await act(async () => { await capturedOnMessage!({ type: "community:message.create", channelId: "ch-1", message: { id: "message-1", seq: 1, authorId: "author-1", authorName: "Alice", authorAvatarVersion: 0, content: "hello", type: "chat", createdAt: "2026-08-27T00:00:00.000Z" } }) })
      expect(canonicalRegistry!.collections.messages.get("message-1")?.createdAt).toBe("2026-08-27T00:00:00.000Z")
      await act(async () => {
        expect(submitReadIntent(lease, { kind: "timeline", channelId: "ch-1", messageId: "message-1", seq: 1 })).toBe(true)
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(getCommunityApiFetchMock()).toHaveBeenCalledWith("/api/community/channels/ch-1/read", expect.anything())
      unmountHook()
      await act(async () => { releaseRead(); await vi.advanceTimersByTimeAsync(0) })
      await vi.waitFor(() => expect(canonicalRegistry!.collections.readStates.get("ch-1")?.lastReadSeq).toBe(1))
      await vi.waitFor(() => expect(attentionCalls()).toHaveLength(1))
      expect(canonicalRegistry!.collections.attentionScopes.get("ch-1")).toBeUndefined()
      expect(capturedQueryClient.getQueryData(communityKeys.accountReadStateSnapshot())).toEqual({ revision: 1 })
      expect(invalidate.mock.calls.some(([filters]) => [communityKeys.inbox(), communityKeys.dms()].some(key => JSON.stringify(filters.queryKey) === JSON.stringify(key)))).toBe(false)
    } finally { releaseRead(); releaseReadSurface(lease); await vi.runAllTimersAsync() }
  })

  it("schedules the first-auth attention owner before read-state reconciliation completes", async () => {
    vi.useFakeTimers()
    await mountHook({ viewerUserId: "viewer-1" })
    act(() => getCapturedRuntime().ws.actions.setPresence("viewer-1", "offline"))
    let releaseSnapshot!: (value: unknown) => void
    getCommunityApiFetchMock().mockImplementationOnce(() => new Promise(resolve => { releaseSnapshot = resolve }))
    let outcome!: Promise<unknown>
    act(() => { outcome = Promise.resolve(capturedUseUserWsOptions!.onAuthenticated!()).then(() => null, error => error) })
    try {
      expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => path === "/api/community/users/me/read-state")).toHaveLength(1)
      expect(getCapturedRuntime().ws.get().presenceByUserId.get("viewer-1")).toBe("online")
      await vi.waitFor(() => expect(attentionCalls()).toHaveLength(1))
      expect(capturedQueryClient.getQueryState(communityKeys.accountReadStateSnapshot())?.fetchStatus).toBe("fetching")
    } finally {
      releaseSnapshot({ revision: 0, readStates: [] })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(await outcome).toBeNull()
    }
    expect(capturedQueryClient.getQueryData(communityKeys.accountReadStateSnapshot())).toEqual({ revision: 0 })
    expect(canonicalRegistry!.collections.readStateClock.get("account")?.revision).toBe(0)
    expect(canonicalRegistry!.collections.readStates.size).toBe(0)
  })

  it.each(["visibilitychange", "pageshow"] as const)("schedules the connected canonical owner on %s", async eventType => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    await act(async () => {
      if (eventType === "visibilitychange") document.dispatchEvent(new Event(eventType))
      else window.dispatchEvent(new PageTransitionEvent(eventType, { persisted: false }))
      await vi.advanceTimersByTimeAsync(1_000)
    })
    await vi.waitFor(() => expect(capturedQueryClient.getQueryData(communityKeys.accountReadStateSnapshot())).toEqual({ revision: 0 }))
    await vi.waitFor(() => expect(capturedQueryClient.getQueryState(communityKeys.accountAttention())?.status).toBe("success"))
    expect(attentionCalls().length).toBeGreaterThan(0)
    expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => path === "/api/community/users/me/read-state")).toHaveLength(1)
    expect(canonicalRegistry!.collections.readStateClock.get("account")?.revision).toBe(0)
  })

  it("contains a visible read-state failure while healthy attention still converges", async () => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    seedCommunityAttentionScope(capturedQueryClient, { channelId: "c1", seq: 4 })
    getCommunityApiFetchMock().mockRejectedValueOnce(new Error("snapshot unavailable"))
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0) })
    await vi.waitFor(() => expect(capturedQueryClient.getQueryState(communityKeys.accountReadStateSnapshot())?.error).toMatchObject({ message: "snapshot unavailable" }))
    await vi.waitFor(() => expect(attentionCalls()).toHaveLength(1))
    expect(canonicalRegistry!.collections.attentionScopes.size).toBe(0)
    expect(capturedQueryClient.getQueryState(communityKeys.accountAttention())?.status).toBe("success")
  })
})
