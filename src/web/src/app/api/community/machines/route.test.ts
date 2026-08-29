import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockListMachinesForUser = vi.fn()
const mockListMachineBackendQuotasForUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMachine: {
        listMachinesForUser: (...args: unknown[]) => mockListMachinesForUser(...args),
        listMachineBackendQuotasForUser: (...args: unknown[]) =>
          mockListMachineBackendQuotasForUser(...args),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (request: any) =>
    handler(request, { env: { DB: {} }, userId: "u1", email: "u@t.com" }),
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  }
})

import { GET } from "./route"

describe("GET /api/community/machines — provider quota", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps same-runtime catalogs isolated between machine rows", async () => {
    const runtime = (modelId: string) => ({
      id: "codex",
      status: "healthy",
      reasoning: {
        updateMode: "unsupported",
        models: [{ id: modelId, supportedReasoningEfforts: [] }],
      },
    })
    mockListMachinesForUser.mockResolvedValue([
      { id: "machine-a", status: "online", availableRuntimes: [runtime("a-model")] },
      { id: "machine-b", status: "online", availableRuntimes: [runtime("b-model")] },
    ])
    mockListMachineBackendQuotasForUser.mockResolvedValue(new Map())

    const response = await GET(new NextRequest("http://localhost/api/community/machines"))
    const body = await response.json() as { machines: Array<{ id: string; availableRuntimes: any[] }> }
    expect(body.machines.map((machine) => ({
      id: machine.id,
      models: machine.availableRuntimes[0]?.reasoning?.models.map((model: any) => model.id),
    }))).toEqual([
      { id: "machine-a", models: ["a-model"] },
      { id: "machine-b", models: ["b-model"] },
    ])
  })

  it("projects one safe machine/backend quota entry per reported runtime", async () => {
    const observedAt = new Date().toISOString()
    mockListMachinesForUser.mockResolvedValue([{
      id: "cm_1",
      status: "online",
      availableRuntimes: [
        { id: "codex", status: "healthy" },
        { id: "claude", status: "unhealthy" },
        { id: "cursor", status: "healthy" },
      ],
    }])
    mockListMachineBackendQuotasForUser.mockResolvedValue(new Map([[
      "cm_1",
      [
        {
          observedAt,
          quota: {
            agentBackendId: "codex",
            observation: {
              status: "available",
              sourceEpoch: "S".repeat(22),
              planName: "Plus",
              freshForSeconds: 300,
              limits: [{
                bucket: {
                  limitId: "primary",
                  product: { kind: "reported", id: "codex", displayName: "Codex" },
                  model: { kind: "not_applicable" },
                  window: { kind: "rolling", durationSeconds: 18_000, displayName: "5 hour usage limit" },
                },
                usedPercent: 37.5,
              }],
            },
          },
        },
        {
          observedAt,
          quota: {
            agentBackendId: "claude",
            observation: {
              status: "error",
              sourceEpoch: "T".repeat(22),
              code: "unauthorized",
              retryable: false,
            },
          },
        },
      ],
    ]]))

    const response = await GET(new NextRequest("http://localhost/api/community/machines"))
    const body = await response.json() as { machines: Array<{ quota: any[] }> }
    expect(response.status).toBe(200)
    expect(body.machines[0]!.quota).toEqual([
      {
        scope: { kind: "machine_backend", machineId: "cm_1", agentBackendId: "codex" },
        capability: "supported",
        runtimeState: "healthy",
        snapshot: {
          status: "available",
          observedAt,
          planName: "Plus",
          limits: [expect.objectContaining({ usedPercent: 37.5 })],
        },
      },
      {
        scope: { kind: "machine_backend", machineId: "cm_1", agentBackendId: "claude" },
        capability: "supported",
        runtimeState: "unhealthy",
        snapshot: { status: "error", code: "unauthorized" },
      },
      {
        scope: { kind: "machine_backend", machineId: "cm_1", agentBackendId: "cursor" },
        capability: "unsupported",
        runtimeState: "healthy",
        snapshot: { status: "pending" },
      },
    ])
    expect(JSON.stringify(body)).not.toContain("sourceEpoch")
    expect(JSON.stringify(body)).not.toContain("retryable")
    expect(mockListMachineBackendQuotasForUser).toHaveBeenCalledWith(expect.anything(), "u1")
  })

  it("marks an expired available observation stale and machine runtimes offline", async () => {
    mockListMachinesForUser.mockResolvedValue([{
      id: "cm_1",
      status: "offline",
      availableRuntimes: [{ id: "codex", status: "healthy" }],
    }])
    mockListMachineBackendQuotasForUser.mockResolvedValue(new Map([[
      "cm_1",
      [{
        observedAt: "2020-01-01T00:00:00.000Z",
        quota: {
          agentBackendId: "codex",
          observation: {
            status: "available",
            sourceEpoch: "U".repeat(22),
            freshForSeconds: 60,
            limits: [{
              bucket: {
                limitId: "primary",
                product: { kind: "unknown", displayName: "Codex" },
                model: { kind: "unknown" },
                window: { kind: "provider_defined", id: "primary", displayName: "Primary" },
              },
              usedPercent: 50,
            }],
          },
        },
      }],
    ]]))

    const response = await GET(new NextRequest("http://localhost/api/community/machines"))
    const body = await response.json() as { machines: Array<{ quota: any[] }> }
    expect(body.machines[0]!.quota[0]).toMatchObject({
      runtimeState: "offline",
      snapshot: { status: "stale", observedAt: "2020-01-01T00:00:00.000Z" },
    })
  })
})
