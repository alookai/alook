import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedQueryClient,
  capturedUseUserWsOptions,
  cleanupCommunityWsHarness,
  flushEffects,
  getCommunityApiFetchMock,
  mountHook,
  resetCommunityWsHarness,
} from "./community-ws/test-harness"

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
})
