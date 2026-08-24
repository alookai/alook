import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import {
  capturedQueryClient,
  capturedUseUserWsOptions,
  cleanupCommunityWsHarness,
  flushEffects,
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
  it("loads the authoritative account snapshot on authentication", async () => {
    await mountHook()
    const invalidate = vi.spyOn(capturedQueryClient, "invalidateQueries")
    await capturedUseUserWsOptions?.onAuthenticated?.()
    expect(capturedQueryClient.getQueryData(
      communityKeys.accountReadStateSnapshot(),
    )).toEqual({ revision: 0, readStates: [] })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: communityKeys.inbox(),
      refetchType: "active",
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: communityKeys.dms(),
      refetchType: "active",
    })
  })

  it.each(["visibilitychange", "pageshow"] as const)(
    "reconciles cached read state on %s",
    async (eventType) => {
      await mountHook()
      flushEffects()
      const listener = eventType === "visibilitychange"
        ? documentListeners.get(eventType)
        : windowListeners.get(eventType)
      expect(listener).toBeTypeOf("function")
      listener!()
      await vi.waitFor(() => expect(capturedQueryClient.getQueryData(
        communityKeys.accountReadStateSnapshot(),
      )).toEqual({ revision: 0, readStates: [] }))
    },
  )
})
