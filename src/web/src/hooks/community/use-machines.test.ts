import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityMachineSummary } from "@alook/shared"

// Mock apiFetch so we control the query function's payload without touching
// the real network. The hook itself can't be rendered in the node vitest env
// (no jsdom), so we exercise the exported query function through a real
// QueryClient — that still proves the queryKey lands in the cache correctly.
const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

const machineFixture: CommunityMachineSummary = {
  id: "m_1",
  hostname: "host",
  displayName: "test",
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.0",
  daemonVersion: "0.1.0",
  lastSeenAt: "2026-07-03T00:00:00.000Z",
  status: "online",
  availableRuntimes: [],
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
}

describe("useMachines / machinesQueryFn", () => {
  it("returns the machines envelope from GET /api/community/machines", async () => {
    apiFetchMock.mockResolvedValueOnce({ machines: [machineFixture] })
    const { machinesQueryFn } = await import("./use-machines")
    const data = await machinesQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/machines")
    expect(data.machines).toEqual([machineFixture])
  })

  it("populates queryClient at communityKeys.machines()", async () => {
    apiFetchMock.mockResolvedValueOnce({ machines: [machineFixture] })
    const { machinesQueryFn } = await import("./use-machines")
    const qc = new QueryClient()
    const key = communityKeys.machines()
    await qc.fetchQuery({ queryKey: key, queryFn: machinesQueryFn })
    expect(qc.getQueryData(key)).toEqual({ machines: [machineFixture] })
    // Prefix invalidation from communityKeys.all cascades to this key.
    await qc.invalidateQueries({ queryKey: communityKeys.all })
    const state = qc.getQueryState(key)
    expect(state?.isInvalidated).toBe(true)
  })
})


describe("machine capacity cache", () => {
  it("updates owned and online counts when a machine disconnects or is removed", async () => {
    const { replaceMachines } = await import("./use-machines")
    const original = { machines: [machineFixture], machineCapacity: { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 1, onlineCount: 1 } }
    const offline = replaceMachines(original, [{ ...machineFixture, status: "offline" }])
    expect(offline.machineCapacity).toMatchObject({ limit: 1, ownedCount: 1, onlineCount: 0 })
    expect(replaceMachines(offline, []).machineCapacity).toMatchObject({ ownedCount: 0, onlineCount: 0 })
    expect(replaceMachines({ machines: [] }, [machineFixture])).toEqual({ machines: [machineFixture] })
  })
})
