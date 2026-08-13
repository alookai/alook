import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMachineByIdForUser = vi.fn()
const mockPushMachineUpdate = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: {
        ...actual.queries.communityMachine,
        getMachineByIdForUser: (...args: unknown[]) => mockGetMachineByIdForUser(...args),
      },
    },
  }
})
vi.mock("@/lib/community/bot-push", () => ({
  pushMachineUpdate: (...args: unknown[]) => mockPushMachineUpdate(...args),
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (request: any, context?: any) => {
    const params = context?.params instanceof Promise ? await context.params : context?.params
    return handler(request, {
      env: { DB: {} },
      userId: context?.actor ?? "owner_1",
      email: "owner@example.com",
      params,
    })
  },
}))

import { POST } from "./route"

const context = { params: { id: "cm_1" } } as any
const request = () => new NextRequest("http://localhost/api/community/machines/cm_1/update", {
  method: "POST",
})
const machine = (overrides: Record<string, unknown> = {}) => ({
  id: "cm_1",
  userId: "owner_1",
  status: "online",
  daemonVersion: "0.1.7",
  ...overrides,
})

describe("POST /api/community/machines/[id]/update", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 404 before delivery for a missing or foreign machine", async () => {
    mockGetMachineByIdForUser.mockResolvedValue(null)

    const response = await POST(request(), context)

    expect(response.status).toBe(404)
    expect(mockGetMachineByIdForUser).toHaveBeenCalledWith({}, "owner_1", "cm_1")
    expect(mockPushMachineUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ["offline", "0.1.7"],
    ["online", "0.1.6"],
    ["online", ""],
    ["online", "abc"],
    ["online", "0.1.7-alpha"],
  ])("returns 409 without delivery for status=%s version=%s", async (status, daemonVersion) => {
    mockGetMachineByIdForUser.mockResolvedValue(machine({ status, daemonVersion }))

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(mockPushMachineUpdate).not.toHaveBeenCalled()
  })

  it("maps an authenticated but absent socket to 409", async () => {
    mockGetMachineByIdForUser.mockResolvedValue(machine())
    mockPushMachineUpdate.mockResolvedValue({ sent: 0, deliveryError: false })

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(mockPushMachineUpdate).toHaveBeenCalledWith(expect.anything(), "cm_1")
  })

  it("maps control-plane failure to 503 instead of claiming the machine is offline", async () => {
    mockGetMachineByIdForUser.mockResolvedValue(machine())
    mockPushMachineUpdate.mockResolvedValue({ sent: 0, deliveryError: true })

    const response = await POST(request(), context)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "could not deliver the daemon update" })
  })

  it("returns dispatch-level success when at least one live socket receives the frame", async () => {
    mockGetMachineByIdForUser.mockResolvedValue(machine({ daemonVersion: "0.2.0" }))
    mockPushMachineUpdate.mockResolvedValue({ sent: 1, deliveryError: false })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ dispatched: true })
  })
})
