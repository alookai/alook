import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { dmsResourceKey } from "@/lib/community-db/dms-resource"
import { readStateResourceKey } from "@/lib/community-db/read-state-resource"
import {
  capturedOnMessage,
  capturedQueryClient,
  capturedUseUserWsOptions,
  cleanupCommunityWsHarness,
  flushEffects,
  getCommunityApiFetchMock,
  getCanonicalRegistryForTests,
  mountHook,
  resetCommunityWsHarness,
  unmountHook,
} from "./community-ws/test-harness"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntent,
} from "./read-coordinator"

const documentListeners = new Map<string, () => void>()
const windowListeners = new Map<string, () => void>()
const emptyAttention = {
  scopes: [], items: [], limit: 100, truncated: false,
  included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
}

beforeEach(async () => {
  documentListeners.clear()
  windowListeners.clear()
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
    removeEventListener: (type: string) => documentListeners.delete(type),
  })
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type),
  })
  await resetCommunityWsHarness()
})

afterEach(async () => {
  await cleanupCommunityWsHarness()
  vi.unstubAllGlobals()
})

describe("community read-state lifecycle reconciliation", () => {
  it("fences owner fallback after cleanup during an active read barrier", async () => {
    vi.useFakeTimers()
    useCommunityStore.getState().subscribe({ channelId: "ch-1" })
    await mountHook({ viewerUserId: "viewer-1" })
    flushEffects()
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
      if (typeof url === "string" && url.endsWith("/read")) {
        await readGate
        return { changed: true, revision: 1, targetSeq: 1 }
      }
      if (url === "/api/community/users/me/read-state") {
        return {
          revision: 1,
          readStates: [{
            channelId: "ch-1",
            lastReadMessageId: "message-1",
            lastReadAt: "2026-08-27T00:00:00.000Z",
            lastReadSeq: 1,
          }],
        }
      }
      if (url === "/api/community/users/me/attention") return emptyAttention
      if (url === "/api/community/servers") return { servers: [] }
      if (url === "/api/community/users/me/dms") return { conversations: [] }
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const lease = registerReadSurface(
      capturedQueryClient,
      "viewer-1",
      { kind: "timeline", channelId: "ch-1" },
    )

    capturedOnMessage!({
      type: "community:message.create",
      channelId: "ch-1",
      message: {
        id: "message-1",
        seq: 1,
        authorId: "author-1",
        authorName: "Alice",
        authorAvatarVersion: 0,
        content: "hello",
        type: "chat",
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    })
    expect(submitReadIntent(lease, {
      kind: "timeline",
      channelId: "ch-1",
      messageId: "message-1",
      seq: 1,
    })).toBe(true)
    vi.advanceTimersByTime(500)
    await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledWith(
      "/api/community/channels/ch-1/read",
      expect.anything(),
    ))

    unmountHook()
    releaseRead()
    await vi.waitFor(() => {
      expect(invalidate.mock.calls.filter(([filters]) => (
        JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.inbox())
      ))).toHaveLength(1)
    })
    await vi.runAllTimersAsync()
    expect(invalidate.mock.calls.filter(([filters]) => (
      filters.predicate?.({ queryKey: dmsResourceKey("u_me") } as never) === true
    ))).toHaveLength(1)
    releaseReadSurface(lease)
  })

  it("schedules the first-auth attention owner before read-state reconciliation completes", async () => {
    vi.useFakeTimers()
    await mountHook({ viewerUserId: "viewer-1" })
    useCommunityWsStore.getState().setPresence("viewer-1", "offline")
    let releaseSnapshot!: (value: unknown) => void
    getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
      if (url === "/api/community/users/me/read-state") {
        return new Promise((resolve) => { releaseSnapshot = resolve })
      }
      if (url === "/api/community/users/me/attention") return emptyAttention
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    const attentionRefetch = vi.spyOn(
      getCanonicalRegistryForTests().collections.attentionScopes.utils,
      "refetch",
    )
    const authentication = capturedUseUserWsOptions?.onAuthenticated?.()

    expect(useCommunityWsStore.getState().presenceByUserId.get("viewer-1"))
      .toBe("online")
    await vi.waitFor(() => expect(attentionRefetch).toHaveBeenCalledTimes(1))
    expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
      path === "/api/community/users/me/read-state"
    ))).toHaveLength(1)

    releaseSnapshot({ revision: 0, readStates: [] })
    await authentication
    expect(capturedQueryClient.getQueryData(
      readStateResourceKey("u_me"),
    )).toMatchObject({ revision: 0, readStates: [] })
  })

  it("reconciles focused messages exactly once on first authentication", async () => {
    useCommunityStore.getState().subscribe({ channelId: "ch-first-auth" })
    await mountHook({ viewerUserId: "viewer-1" })
    const reconcile = vi.spyOn(getCanonicalRegistryForTests(), "reconcileMessageScope")
    const apiFetch = getCommunityApiFetchMock()
    apiFetch.mockImplementation(async (url: unknown) => {
      if (url === "/api/community/users/me/read-state") {
        return { revision: 0, readStates: [] }
      }
      if (url === "/api/community/users/me/attention") {
        return {
          scopes: [], items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        }
      }
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })

    await capturedUseUserWsOptions?.onAuthenticated?.()
    await capturedUseUserWsOptions?.onAuthenticated?.()

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledWith("server-channel", "ch-first-auth")
  })

  it.each(["visibilitychange", "pageshow"] as const)(
    "schedules the connected owner and reconciles non-Inbox state on %s",
    async (eventType) => {
      vi.useFakeTimers()
      await mountHook()
      flushEffects()
      const listener = eventType === "visibilitychange"
        ? documentListeners.get(eventType)
        : windowListeners.get(eventType)
      expect(listener).toBeTypeOf("function")
      listener!()
      await vi.waitFor(() => expect(capturedQueryClient.getQueryData(
        readStateResourceKey("u_me"),
      )).toMatchObject({ revision: 0, readStates: [] }))
      await vi.waitFor(() => expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
        path === "/api/community/users/me/attention"
      ))).toHaveLength(1))
      await vi.waitFor(() => expect(capturedQueryClient.isFetching()).toBe(0))
    },
  )

  it("contains a visible lifecycle reconciliation failure while attention still reconciles", async () => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    vi.spyOn(console, "error").mockImplementation(() => {})
    getCommunityApiFetchMock().mockImplementation(async (url: unknown) => {
      if (url === "/api/community/users/me/read-state") {
        throw new Error("snapshot unavailable")
      }
      if (url === "/api/community/users/me/attention") return emptyAttention
      throw new Error(`unexpected API fetch: ${String(url)}`)
    })
    const attentionRefetch = vi.spyOn(
      getCanonicalRegistryForTests().collections.attentionScopes.utils,
      "refetch",
    )

    documentListeners.get("visibilitychange")!()
    await vi.waitFor(() => expect(attentionRefetch).toHaveBeenCalledTimes(1))
    expect(getCommunityApiFetchMock().mock.calls.some(([path]) => (
      path === "/api/community/users/me/read-state"
    ))).toBe(true)
    await vi.waitFor(() => expect(capturedQueryClient.isFetching()).toBe(0))
  })
})
