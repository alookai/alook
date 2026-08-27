import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  listMemberServerIds: vi.fn(),
  readSnapshot: vi.fn(),
  applyProjection: vi.fn(),
  getFolder: vi.fn(),
  nanoid: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: () => ({ id: "db" }) }))
vi.mock("nanoid", async () => {
  const actual = await vi.importActual<typeof import("nanoid")>("nanoid")
  return { ...actual, nanoid: () => mocks.nanoid() }
})
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMember: { listMemberServerIds: (...args: unknown[]) => mocks.listMemberServerIds(...args) },
      communityServerFolder: { getFolder: (...args: unknown[]) => mocks.getFolder(...args) },
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
  }),
}))

import { POST } from "./route"

function request(body: unknown) {
  return new NextRequest("http://localhost/api/community/users/me/server-folders", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("legacy server-folders POST rail invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.nanoid.mockReturnValueOnce("client").mockReturnValueOnce("folder")
    mocks.listMemberServerIds.mockResolvedValue(["server_1"])
    mocks.readSnapshot.mockResolvedValue({
      serverOrder: ["server_1"],
      folderOrder: [],
      folders: {},
    })
    mocks.applyProjection.mockResolvedValue(undefined)
    mocks.getFolder.mockResolvedValue({ id: "folder", name: "Group", position: 0 })
  })

  it.each([undefined, []])("rejects an empty folder before reading or writing: %j", async (serverIds) => {
    const response = await POST(request({ name: "Group", serverIds }), {} as any)

    expect(response.status).toBe(400)
    expect(mocks.readSnapshot).not.toHaveBeenCalled()
    expect(mocks.applyProjection).not.toHaveBeenCalled()
  })

  it("routes legacy creates through the guarded rail projection batch", async () => {
    const response = await POST(request({ name: "Group", serverIds: ["server_1"] }), {} as any)

    expect(response.status).toBe(201)
    expect(mocks.applyProjection).toHaveBeenCalledWith(
      { id: "db" },
      "user_1",
      expect.objectContaining({
        createdFolders: [{ id: "folder", name: "Group", serverIds: ["server_1"] }],
      }),
    )
  })
})
