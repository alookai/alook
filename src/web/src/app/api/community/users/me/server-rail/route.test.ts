import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { MAX_SERVER_RAIL_REQUEST_BYTES } from "@alook/shared"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockReadSnapshot = vi.fn()
const mockApplyProjection = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ id: "db" })) }))
vi.mock("nanoid", async () => {
  const actual = await vi.importActual<typeof import("nanoid")>("nanoid")
  return { ...actual, nanoid: vi.fn(() => "folder_generated") }
})
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityServerRail: {
        readServerRailSnapshot: (...args: unknown[]) => mockReadSnapshot(...args),
        applyServerRailProjection: (...args: unknown[]) => mockApplyProjection(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any) => handler(req, {
    env: { DB: {} },
    userId: "user_1",
    email: "u@example.com",
  })),
}))

import { PATCH } from "./route"

const snapshot = {
  serverOrder: ["server_1", "server_2", "server_3"],
  folderOrder: ["folder_1"],
  folders: {
    folder_1: { id: "folder_1", name: "Folder", serverIds: ["server_2"] },
  },
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/community/users/me/server-rail", {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

describe("PATCH /api/community/users/me/server-rail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSnapshot.mockResolvedValue(snapshot)
    mockApplyProjection.mockResolvedValue(undefined)
  })

  it("commits one validated projection and returns generated folder ids", async () => {
    const response = await PATCH(patchRequest({
      commands: [{
        kind: "create-folder",
        clientId: "temp_1",
        name: "Pair",
        serverIds: ["server_1", "server_3"],
      }],
    }), {} as any)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      createdFolderIds: { temp_1: "folder_generated" },
    })
    expect(mockReadSnapshot).toHaveBeenCalledWith({ id: "db" }, "user_1")
    expect(mockApplyProjection).toHaveBeenCalledTimes(1)
    expect(mockApplyProjection).toHaveBeenCalledWith(
      { id: "db" },
      "user_1",
      expect.objectContaining({
        createdFolderIds: { temp_1: "folder_generated" },
        movedServerIds: ["server_1", "server_3"],
      }),
    )
  })

  it.each([
    ["malformed JSON", "{"],
    ["empty commands", { commands: [] }],
    ["unknown fields", { commands: [{ kind: "reorder-servers", serverIds: snapshot.serverOrder, extra: true }] }],
    ["partial memberships", { commands: [{ kind: "reorder-servers", serverIds: ["server_1"] }] }],
    ["duplicate memberships", { commands: [{ kind: "reorder-servers", serverIds: ["server_1", "server_1", "server_3"] }] }],
    ["foreign folder", { commands: [{ kind: "delete-folder", folderId: "folder_foreign" }] }],
  ])("rejects %s without a write", async (_name, body) => {
    const response = await PATCH(patchRequest(body), {} as any)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mockApplyProjection).not.toHaveBeenCalled()
  })

  it("rejects an oversized UTF-8 body before reading a snapshot", async () => {
    const response = await PATCH(
      patchRequest(`{"commands":[],"padding":"${"界".repeat(MAX_SERVER_RAIL_REQUEST_BYTES)}"}`),
      {} as any,
    )

    expect(response.status).toBe(413)
    expect(mockReadSnapshot).not.toHaveBeenCalled()
    expect(mockApplyProjection).not.toHaveBeenCalled()
  })

  it("accepts a complete 125-membership reorder without cardinality rejection", async () => {
    const serverOrder = Array.from({ length: 125 }, (_, index) => `server_${index}`)
    mockReadSnapshot.mockResolvedValue({ serverOrder, folderOrder: [], folders: {} })

    const response = await PATCH(patchRequest({
      commands: [{ kind: "reorder-servers", serverIds: [...serverOrder].reverse() }],
    }), {} as any)

    expect(response.status).toBe(200)
    expect(mockApplyProjection).toHaveBeenCalledTimes(1)
  })

  it("returns a 404 and executes zero writes for an unknown owned resource", async () => {
    const response = await PATCH(patchRequest({
      commands: [{ kind: "replace-folder-items", folderId: "missing", serverIds: ["server_1"] }],
    }), {} as any)

    expect(response.status).toBe(404)
    expect(mockApplyProjection).not.toHaveBeenCalled()
  })
})
