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
import {
  registerReadSurface,
  releaseReadSurface,
  submitReadIntent,
} from "./read-coordinator"

const documentListeners = new Map<string, () => void>()
const windowListeners = new Map<string, () => void>()

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

  it("schedules the first-auth owner before non-Inbox reconciliation completes", async () => {
    vi.useFakeTimers()
    await mountHook()
    let releaseSnapshot!: (value: unknown) => void
    getCommunityApiFetchMock().mockReturnValueOnce(new Promise((resolve) => {
      releaseSnapshot = resolve
    }))
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
    const authentication = capturedUseUserWsOptions?.onAuthenticated?.()

    expect(getCommunityApiFetchMock()).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: communityKeys.inbox(),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: communityKeys.dms(),
    })

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
      const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
      const listener = eventType === "visibilitychange"
        ? documentListeners.get(eventType)
        : windowListeners.get(eventType)
      expect(listener).toBeTypeOf("function")
      listener!()
      await vi.waitFor(() => expect(capturedQueryClient.getQueryData(
        communityKeys.accountReadStateSnapshot(),
      )).toEqual({ revision: 0, readStates: [] }))
      expect(invalidate).not.toHaveBeenCalledWith({
        queryKey: communityKeys.inbox(),
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: communityKeys.inbox(),
      })
    },
  )

  it("contains a visible lifecycle reconciliation failure while the owner still refreshes", async () => {
    vi.useFakeTimers()
    await mountHook()
    flushEffects()
    getCommunityApiFetchMock().mockRejectedValueOnce(new Error("snapshot unavailable"))
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")

    documentListeners.get("visibilitychange")!()
    await vi.waitFor(() => expect(getCommunityApiFetchMock()).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(500)

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.dms() })
  })
})
