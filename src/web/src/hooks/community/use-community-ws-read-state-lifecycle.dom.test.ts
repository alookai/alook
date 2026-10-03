import { getCapturedRuntime } from "./community-ws/test-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
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
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntent,
} from "./read-coordinator"

beforeEach(async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  await resetCommunityWsHarness()
})

afterEach(async () => {
  await cleanupCommunityWsHarness()
  vi.unstubAllGlobals()
})

describe("community read-state lifecycle reconciliation", () => {
  it("fences owner fallback after cleanup during an active read barrier", async () => {
    vi.useFakeTimers()
    getCapturedRuntime().ui.actions.subscribe({ channelId: "ch-1" })
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
    await vi.advanceTimersByTimeAsync(500)
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
      JSON.stringify(filters.queryKey) === JSON.stringify(communityKeys.dms())
    ))).toHaveLength(1)
    releaseReadSurface(lease)
  })

  it("schedules the first-auth attention owner before read-state reconciliation completes", async () => {
    vi.useFakeTimers()
    await mountHook({ viewerUserId: "viewer-1" })
    getCapturedRuntime().ws.actions.setPresence("viewer-1", "offline")
    let releaseSnapshot!: (value: unknown) => void
    getCommunityApiFetchMock().mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = resolve
    }))
    const authentication = capturedUseUserWsOptions?.onAuthenticated?.()

    expect(getCommunityApiFetchMock()).toHaveBeenCalledOnce()
    expect(getCapturedRuntime().ws.get().presenceByUserId.get("viewer-1"))
      .toBe("online")
    await vi.waitFor(() => expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
      path === "/api/community/users/me/attention"
    ))).toHaveLength(1))

    releaseSnapshot({ revision: 0, readStates: [] })
    await authentication
    expect(capturedQueryClient.getQueryData(
      communityKeys.accountReadStateSnapshot(),
    )).toEqual({ revision: 0, readStates: [] })
  })

  it.each(["visibilitychange", "pageshow"] as const)(
    "schedules the connected owner and reconciles non-Inbox state on %s",
    async (eventType) => {
      vi.useFakeTimers()
      await mountHook()
      flushEffects()
      if (eventType === "visibilitychange") document.dispatchEvent(new Event(eventType))
      else window.dispatchEvent(new PageTransitionEvent(eventType, { persisted: false }))
      await vi.waitFor(() => expect(capturedQueryClient.getQueryData(
        communityKeys.accountReadStateSnapshot(),
      )).toEqual({ revision: 0, readStates: [] }))
      await vi.waitFor(() => expect(getCommunityApiFetchMock().mock.calls.filter(([path]) => (
        path === "/api/community/users/me/attention"
      ))).toHaveLength(1))
    },
  )

  it("contains a visible lifecycle reconciliation failure while attention still reconciles", async () => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    getCommunityApiFetchMock().mockRejectedValueOnce(new Error("snapshot unavailable"))

    document.dispatchEvent(new Event("visibilitychange"))
    await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(getCommunityApiFetchMock().mock.calls.some(([path]) => (
      path === "/api/community/users/me/attention"
    ))).toBe(true))
  })
})
