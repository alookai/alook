import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  getFolder: vi.fn(),
  listMemberServerIds: vi.fn(),
  readSnapshot: vi.fn(),
  applyProjection: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: () => ({ id: "db" }) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMember: { listMemberServerIds: (...args: unknown[]) => mocks.listMemberServerIds(...args) },
      communityServerFolder: {
        getFolder: (...args: unknown[]) => mocks.getFolder(...args),
        updateFolder: vi.fn(),
        deleteFolder: vi.fn(),
      },
      communityServerRail: {
        readServerRailSnapshot: (...args: unknown[]) => mocks.readSnapshot(...args),
        applyServerRailProjection: (...args: unknown[]) => mocks.applyProjection(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: NextRequest) => handler(req, {
    env: { DB: {} },
    userId: "user_1",
    params: { id: "folder_1" },
  }),
}))

import { PATCH } from "./route"

function request(serverIds: string[]) {
  return new NextRequest("http://localhost/api/community/users/me/server-folders/folder_1", {
    method: "PATCH",
    body: JSON.stringify({ serverIds }),
  })
}

describe("legacy server-folders PATCH rail invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getFolder.mockResolvedValue({ id: "folder_1", name: "Group", position: 0 })
    mocks.listMemberServerIds.mockResolvedValue(["server_1", "server_2"])
    mocks.readSnapshot.mockResolvedValue({
      serverOrder: ["server_1", "server_2"],
      folderOrder: ["folder_1"],
      folders: {
        folder_1: { id: "folder_1", name: "Group", serverIds: ["server_1"] },
      },
    })
    mocks.applyProjection.mockResolvedValue(undefined)
  })

  it("rejects replacing a folder with an empty item list", async () => {
    const response = await PATCH(request([]), {} as any)

    expect(response.status).toBe(400)
    expect(mocks.readSnapshot).not.toHaveBeenCalled()
    expect(mocks.applyProjection).not.toHaveBeenCalled()
  })

  it("routes legacy item replacement through the rail projection batch", async () => {
    const response = await PATCH(request(["server_2"]), {} as any)

    expect(response.status).toBe(200)
    expect(mocks.applyProjection).toHaveBeenCalledWith(
      { id: "db" },
      "user_1",
      expect.objectContaining({
        affectedFolderIds: ["folder_1"],
        movedServerIds: ["server_1", "server_2"],
      }),
    )
  })
})
