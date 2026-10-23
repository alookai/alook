import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { MAX_SERVER_RAIL_REQUEST_BYTES } from "@alook/shared"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockReadSnapshot = vi.fn()
const mockApplyProjection = vi.fn()
const mockBroadcast = vi.fn()
vi.mock("@/lib/community/fanout", () => ({ broadcastToUserSafe: (...args: unknown[]) => mockBroadcast(...args) }))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ id: "db" })), getPrimaryDb: vi.fn(() => ({ id: "db" })) }))
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
  serverIds: ["server_1", "server_2", "server_3"],
  folderIds: ["folder_1"],
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
    mockBroadcast.mockResolvedValue(undefined)
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
    expect(mockBroadcast).toHaveBeenCalledExactlyOnceWith("user_1", { type: "community:server_rail.changed" })
    expect(mockApplyProjection.mock.invocationCallOrder[0]).toBeLessThan(mockBroadcast.mock.invocationCallOrder[0])
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
    ["unknown fields", { commands: [{ kind: "reorder-servers", serverIds: snapshot.serverIds, extra: true }] }],
    ["partial root set", { commands: [{ kind: "reorder-top-level", entries: [{ kind: "server", id: "server_1" }] }] }],
    ["duplicate root set", { commands: [{ kind: "reorder-top-level", entries: [{ kind: "server", id: "server_1" }, { kind: "server", id: "server_1" }] }] }],
    ["foreign folder", { commands: [{ kind: "delete-folder", folderId: "folder_foreign" }] }],
  ])("rejects %s without a write", async (_name, body) => {
    const response = await PATCH(patchRequest(body), {} as any)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(mockApplyProjection).not.toHaveBeenCalled()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it("rejects an oversized UTF-8 body before reading a snapshot", async () => {
    const response = await PATCH(
      patchRequest(`{"commands":[],"padding":"${"界".repeat(MAX_SERVER_RAIL_REQUEST_BYTES)}"}`),
      {} as any,
    )

    expect(response.status).toBe(413)
    expect(mockReadSnapshot).not.toHaveBeenCalled()
    expect(mockApplyProjection).not.toHaveBeenCalled()
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it("accepts a complete 125-membership reorder without cardinality rejection", async () => {
    const serverIds = Array.from({ length: 125 }, (_, index) => `server_${index}`)
    mockReadSnapshot.mockResolvedValue({ serverIds, folderIds: [], folders: {} })

    const response = await PATCH(patchRequest({
      commands: [{ kind: "reorder-top-level", entries: [...serverIds].reverse().map((id) => ({ kind: "server", id })) }],
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
    expect(mockBroadcast).not.toHaveBeenCalled()
  })
  it("does not broadcast a failed atomic save", async () => {
    mockApplyProjection.mockRejectedValue(new Error("D1 write failed"))
    await expect(PATCH(patchRequest({ commands: [{ kind: "delete-folder", folderId: "folder_1" }] }), {} as any)).rejects.toThrow("D1 write failed")
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

})
