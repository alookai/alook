import { describe, expect, it } from "vitest";
import {
  projectServerRailCommit,
  serverRailCommitRequestSchema,
  type ServerRailState,
} from "./community-server-rail";

function snapshot(): ServerRailState {
  return {
    serverOrder: ["a", "b", "c", "d", "e"],
    folderOrder: ["one", "two"],
    folders: {
      one: { id: "one", name: "One", serverIds: ["c", "d"] },
      two: { id: "two", name: "Two", serverIds: ["e"] },
    },
  };
}

describe("server rail wire contract", () => {
  it("is strict, bounded, and rejects duplicate semantic commands", () => {
    expect(serverRailCommitRequestSchema.safeParse({ commands: [] }).success).toBe(false);
    expect(serverRailCommitRequestSchema.safeParse({
      commands: [{ kind: "delete-folder", folderId: "one", extra: true }],
    }).success).toBe(false);

    const result = projectServerRailCommit(snapshot(), {
      commands: [
        { kind: "replace-folder-items", folderId: "one", serverIds: ["c"] },
        { kind: "delete-folder", folderId: "one" },
      ],
    }, () => "new");
    expect(result).toEqual({ ok: false, error: "duplicate command for folder one", status: 400 });
  });

  it("projects a cross-folder move and identifies only affected resources", () => {
    const result = projectServerRailCommit(snapshot(), {
      commands: [
        { kind: "replace-folder-items", folderId: "one", serverIds: ["d"] },
        { kind: "replace-folder-items", folderId: "two", serverIds: ["e", "c"] },
      ],
    }, () => "new");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after.folders.one.serverIds).toEqual(["d"]);
    expect(result.value.after.folders.two.serverIds).toEqual(["e", "c"]);
    expect(result.value.affectedFolderIds).toEqual(["one", "two"]);
    expect(result.value.movedServerIds).toEqual(["c"]);
  });

  it("maps a client folder id and rejects duplicate folder membership", () => {
    const created = projectServerRailCommit(snapshot(), {
      commands: [{ kind: "create-folder", clientId: "tmp", name: "Group", serverIds: ["a", "b"] }],
    }, () => "real");
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.createdFolderIds).toEqual({ tmp: "real" });
      expect(created.value.after.folders.real.serverIds).toEqual(["a", "b"]);
    }

    const duplicate = projectServerRailCommit(snapshot(), {
      commands: [{ kind: "replace-folder-items", folderId: "two", serverIds: ["e", "c"] }],
    }, () => "new");
    expect(duplicate).toMatchObject({ ok: false, error: "server c belongs to multiple folders" });
  });

  it("accepts a complete 101+ membership reorder without a cardinality cliff", () => {
    const ids = Array.from({ length: 125 }, (_, index) => `server-${index}`);
    const state: ServerRailState = { serverOrder: ids, folderOrder: [], folders: {} };
    const result = projectServerRailCommit(state, {
      commands: [{ kind: "reorder-servers", serverIds: [...ids].reverse() }],
    }, () => "unused");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.after.serverOrder).toEqual([...ids].reverse());
  });

  it("requires complete reorder sets and rejects no-ops", () => {
    expect(projectServerRailCommit(snapshot(), {
      commands: [{ kind: "reorder-servers", serverIds: ["a", "b"] }],
    }, () => "new")).toMatchObject({ ok: false, error: "serverIds must match current memberships" });

    expect(projectServerRailCommit(snapshot(), {
      commands: [{ kind: "reorder-folders", folderIds: ["one", "two"] }],
    }, () => "new")).toMatchObject({ ok: false, error: "rail command is a no-op" });
  });
});
