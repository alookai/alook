import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getMachineTokenByToken = vi.fn()
const updateMachineTokenLastUsed = vi.fn()
const runtimeLookup = vi.fn()
const kvGet = vi.fn().mockResolvedValue(null)
const kvPut = vi.fn().mockResolvedValue(undefined)

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { DB: {}, CACHE_KV: { get: kvGet, put: kvPut, delete: vi.fn() } },
  })),
}))
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
  withD1Retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      machineToken: {
        getMachineTokenByToken: (...args: unknown[]) => getMachineTokenByToken(...args),
        updateMachineTokenLastUsed: (...args: unknown[]) => updateMachineTokenLastUsed(...args),
      },
      runtime: { getRuntimeIdsByDaemon: (...args: unknown[]) => runtimeLookup(...args) },
    },
  }
})
vi.mock("@/lib/cache", () => ({
  bindCacheKV: vi.fn(),
  getKV: vi.fn(() => ({ get: kvGet, put: kvPut, delete: vi.fn() })),
  cacheKeys: {
    machineToken: (token: string) => `mt:${token}`,
    runtimeIds: (workspaceId: string, daemonId: string) => `runtime:${workspaceId}:${daemonId}`,
  },
  cached: vi.fn(),
  throttled: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ createAuth: vi.fn() }))

import { POST } from "./route"

function request(token: string) {
  return new NextRequest("http://localhost/api/daemon/tasks/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ daemon_id: "daemon-1", max_tasks: 0 }),
  })
}

describe("poll authentication precedes max_tasks validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvGet.mockResolvedValue(null)
  })

  it("returns 401 for invalid-token + zero before entering route work", async () => {
    getMachineTokenByToken.mockResolvedValue(null)
    const response = await POST(request("al_invalid"))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "invalid token" })
    expect(runtimeLookup).not.toHaveBeenCalled()
  })

  it("returns 400 for valid-token + zero before any poll work", async () => {
    getMachineTokenByToken.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      userEmail: "owner@example.com",
      workspaceId: "workspace-1",
    })
    const response = await POST(request("al_valid"))
    expect(response.status).toBe(400)
    expect(runtimeLookup).not.toHaveBeenCalled()
  })
})
