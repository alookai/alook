import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { listFolders } = vi.hoisted(() => ({ listFolders: vi.fn() }))
vi.mock("@/lib/db", () => ({ getDb: () => ({ id: "db" }), getPrimaryDb: () => ({ id: "db" }) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { communityServerFolder: { listFolders } } }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (request: NextRequest) => handler(request, {
    userId: "viewer",
    env: { DB: {} },
  }),
}))
import { GET } from "./route"

describe("GET server folders", () => {
  it("retains the current account-scoped folder list", async () => {
    const folders = [{ id: "folder", name: "Group", position: 0, servers: [{ id: "server", name: "Server" }] }]
    listFolders.mockResolvedValue({ folders, topOrder: [] })
    const response = await GET(new NextRequest("http://localhost/api/community/users/me/server-folders"), {} as any)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ folders, topOrder: [] })
    expect(listFolders).toHaveBeenCalledWith({ id: "db" }, "viewer")
  })

  it("returns the same account's saved mixed order", async () => {
    const topOrder = [{ kind: "folder", id: "folder" }, { kind: "server", id: "server" }]
    listFolders.mockResolvedValue({ folders: [], topOrder })
    const response = await GET(new NextRequest("http://localhost/api/community/users/me/server-folders"), {} as any)
    expect(await response.json()).toEqual({ folders: [], topOrder })
  })
})
