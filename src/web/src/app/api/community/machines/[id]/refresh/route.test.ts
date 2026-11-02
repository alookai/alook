import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getMachine = vi.fn()
const pushRefresh = vi.fn()
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async (original) => ({ ...await original<typeof import("@alook/shared")>(), queries: { communityMachine: { getMachineByIdForUser: (...args: unknown[]) => getMachine(...args) } } }))
vi.mock("@/lib/community/bot-push", () => ({ pushMachineRefresh: (...args: unknown[]) => pushRefresh(...args) }))
vi.mock("@/lib/middleware/auth", () => ({
  humanAuthPolicy: { resolve: async (request: NextRequest) => ({ context: { env: { DB: {} }, userId: "owner", email: "owner@test.local" } }) },
}))

import { POST } from "./route"
const request = () => new NextRequest("http://localhost/api/community/machines/m/refresh", { method: "POST" })
const context = { params: Promise.resolve({ id: "m" }) }

describe("POST /api/community/machines/[id]/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMachine.mockResolvedValue({ id: "m", userId: "owner", status: "online" })
    pushRefresh.mockResolvedValue({ sent: 1, unsupported: 0, deliveryError: false })
  })

  it("requires an ID before any lookup or command", async () => {
    expect((await POST(request(), { params: Promise.resolve({}) })).status).toBe(400)
    expect(getMachine).not.toHaveBeenCalled()
    expect(pushRefresh).not.toHaveBeenCalled()
  })

  it("scopes the lookup to the owner and does not send to missing or foreign machines", async () => {
    getMachine.mockResolvedValue(null)
    expect((await POST(request(), context)).status).toBe(404)
    expect(getMachine).toHaveBeenCalledWith({}, "owner", "m")
    expect(pushRefresh).not.toHaveBeenCalled()
  })

  it("does not send to an already offline machine", async () => {
    getMachine.mockResolvedValue({ id: "m", status: "offline" })
    expect((await POST(request(), context)).status).toBe(409)
    expect(pushRefresh).not.toHaveBeenCalled()
  })

  it.each([
    [{ sent: 0, unsupported: 0, deliveryError: false }, 409, "machine is offline"],
    [{ sent: 0, unsupported: 1, deliveryError: false }, 409, "update this daemon before remote Refresh is available"],
    [{ sent: 0, unsupported: 0, deliveryError: true }, 503, "could not deliver the daemon refresh command"],
  ])("returns a truthful failure for %j", async (receipt, status, error) => {
    pushRefresh.mockResolvedValue(receipt)
    const response = await POST(request(), context)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error })
  })

  it("returns only dispatch success and retains the machine object", async () => {
    const machine = { id: "m", userId: "owner", status: "online" }
    getMachine.mockResolvedValue(machine)
    const response = await POST(request(), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ dispatched: true })
    expect(machine).toEqual({ id: "m", userId: "owner", status: "online" })
    expect(pushRefresh).toHaveBeenCalledWith({ DB: {} }, "m")
  })
  it("ignores supplied input and dispatches only the owner-scoped machine action", async () => {
    const input = new NextRequest("http://localhost/api/community/machines/m/refresh", {
      method: "POST", body: JSON.stringify({ env: { KEY: "private" }, command: "shell" }),
    });
    const response = await POST(input, context);
    expect(await response.json()).toEqual({ dispatched: true });
    expect(pushRefresh).toHaveBeenCalledExactlyOnceWith({ DB: {} }, "m");
  });
});
