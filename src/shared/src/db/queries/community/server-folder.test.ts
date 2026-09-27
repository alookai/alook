import { describe, expect, it, vi } from "vitest"
import { listFolders } from "./server-folder"

describe("listFolders", () => {
  it("keeps an unavailable server reference renderable", async () => {
    const folderChain: Record<string, ReturnType<typeof vi.fn>> = {}
    folderChain.from = vi.fn(() => folderChain)
    folderChain.where = vi.fn(() => folderChain)
    folderChain.orderBy = vi.fn().mockResolvedValue([{ id: "folder_1", name: "Saved", position: 0 }])

    const itemChain: Record<string, ReturnType<typeof vi.fn>> = {}
    itemChain.from = vi.fn(() => itemChain)
    itemChain.leftJoin = vi.fn(() => itemChain)
    itemChain.where = vi.fn(() => itemChain)
    itemChain.orderBy = vi.fn().mockResolvedValue([{
      serverId: "server_missing",
      position: 0,
      serverName: null,
      serverIcon: null,
    }])

    const db = {
      select: vi.fn()
        .mockReturnValueOnce(folderChain)
        .mockReturnValueOnce(itemChain),
    }

    await expect(listFolders(db as never, "user_1")).resolves.toEqual([{
      id: "folder_1",
      name: "Saved",
      position: 0,
      servers: [{ id: "server_missing", name: "Server unavailable", icon: null }],
    }])
  })
})
