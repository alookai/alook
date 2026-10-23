import { describe, expect, it, vi } from "vitest";
const { readServerRailSnapshot } = vi.hoisted(() => ({ readServerRailSnapshot: vi.fn() }));
vi.mock("./server-rail", () => ({ readServerRailSnapshot }));
import { listFolders } from "./server-folder";

describe("listFolders", () => {
  it("uses canonical folder order and scoped live member data", async () => {
    const topOrder = [{ kind: "folder", id: "second" }, { kind: "server", id: "a" }, { kind: "folder", id: "first" }];
    readServerRailSnapshot.mockResolvedValue({
      serverIds: ["a", "b", "c"], folderIds: ["first", "second"], topOrder,
      folders: { first: { id: "first", name: "First", serverIds: ["b"] }, second: { id: "second", name: "Second", serverIds: ["c"] } },
    });
    const chain: any = { from: () => chain, innerJoin: async () => [{ id: "b", name: "B", icon: null }, { id: "c", name: "C", icon: "c.png" }] };
    const db = { select: () => chain };
    await expect(listFolders(db as never, "viewer")).resolves.toEqual({ topOrder, folders: [
      { id: "second", name: "Second", servers: [{ id: "c", name: "C", icon: "c.png" }] },
      { id: "first", name: "First", servers: [{ id: "b", name: "B", icon: null }] },
    ] });
    expect(readServerRailSnapshot).toHaveBeenCalledWith(db, "viewer");
  });
});
