import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({ list: vi.fn(async () => []) }))
vi.mock("@/lib/db", () => ({ getDb: () => "normal-db", getPrimaryDb: () => "primary-db" }))
vi.mock("@alook/shared", () => ({ queries: { communityBot: { listBotsForMachine: mocks.list } } }))
vi.mock("@/lib/middleware/community-daemon-auth", () => ({ withCommunityDaemonAuth: (handler: (req: NextRequest, ctx: unknown) => Promise<Response>) => (req: NextRequest) => handler(req, { env: { DB: {} }, machineId: "bound-machine" }) }))
import { GET } from "./route"
describe("daemon bound bot inventory", () => {
  it("keeps normal warmup active-only and scopes both modes to the authenticated machine", async () => {
    await GET(new NextRequest("https://alook.ai/api/community/daemon/bots"))
    expect(mocks.list).toHaveBeenLastCalledWith("normal-db", "bound-machine", { includeInactive: false })
    await GET(new NextRequest("https://alook.ai/api/community/daemon/bots?includeInactive=true"))
    expect(mocks.list).toHaveBeenLastCalledWith("primary-db", "bound-machine", { includeInactive: true })
  })
})
