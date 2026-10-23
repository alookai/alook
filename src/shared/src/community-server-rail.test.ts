import { describe, expect, it } from "vitest";
import {
  projectServerRailCommit,
  serverRailTopOrder,
  serverRailServerIds,
  serverRailCommitRequestSchema,
  type ServerRailState,
} from "./community-server-rail";

function snapshot(): ServerRailState {
  return {
    serverIds: ["a", "b", "c", "d", "e"],
    folderIds: ["one", "two"],
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
    const state: ServerRailState = { serverIds: ids, folderIds: [], folders: {} };
    const result = projectServerRailCommit(state, {
      commands: [{ kind: "reorder-top-level", entries: [...ids].reverse().map((id) => ({ kind: "server", id })) }],
    }, () => "unused");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.after.topOrder).toEqual([...ids].reverse().map((id) => ({ kind: "server", id })));
  });

  it("requires complete reorder sets and rejects no-ops", () => {
    expect(projectServerRailCommit(snapshot(), {
      commands: [{ kind: "reorder-top-level", entries: [{ kind: "server", id: "a" }, { kind: "server", id: "b" }] }],
    }, () => "new")).toMatchObject({ ok: false, error: "top-level entries must match current servers and folders" });

    expect(projectServerRailCommit(snapshot(), {
      commands: [{ kind: "reorder-top-level", entries: serverRailTopOrder(snapshot()) }],
    }, () => "new")).toMatchObject({ ok: false, error: "rail command is a no-op" });
  });
});

describe("personal mixed top-level order", () => {
  it("validates the exact visible set and maps new folder identities", () => {
    const state: ServerRailState = { serverIds: ["a", "b", "c"], folderIds: [], folders: {} };
    const result = projectServerRailCommit(state, { commands: [
      { kind: "create-folder", clientId: "temp", name: "Group", serverIds: ["b", "a"] },
      { kind: "reorder-top-level", entries: [{ kind: "folder", id: "temp" }, { kind: "server", id: "c" }] },
    ] }, () => "confirmed");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.after.topOrder).toEqual([{ kind: "folder", id: "confirmed" }, { kind: "server", id: "c" }]);
      expect(result.value.reorderTopLevel).toBe(true);
    }
    for (const entries of [
      [{ kind: "server" as const, id: "foreign" }],
      [{ kind: "server" as const, id: "a" }, { kind: "server" as const, id: "a" }, { kind: "server" as const, id: "b" }, { kind: "server" as const, id: "c" }],
    ]) expect(projectServerRailCommit(state, { commands: [{ kind: "reorder-top-level", entries }] }, () => "unused").ok).toBe(false);
  });
  it("rejects a same-order no-op and duplicate top-order commands", () => {
    const state: ServerRailState = { serverIds: ["a", "b"], folderIds: [], folders: {} };
    const command = { kind: "reorder-top-level" as const, entries: [{ kind: "server" as const, id: "a" }, { kind: "server" as const, id: "b" }] };
    expect(projectServerRailCommit(state, { commands: [command] }, () => "unused").ok).toBe(false);
    expect(projectServerRailCommit(state, { commands: [command, command] }, () => "unused")).toMatchObject({ ok: false, error: "duplicate reorder-top-level command" });
  });
});

it("rejects obsolete independent order commands and flattens only canonical roots", () => {
  for (const kind of ["reorder-servers", "reorder-folders"]) expect(serverRailCommitRequestSchema.safeParse({ commands: [{ kind, serverIds: ["a"], folderIds: [] }] }).success).toBe(false);
  const state = { ...snapshot(), topOrder: [{ kind: "folder" as const, id: "two" }, { kind: "server" as const, id: "b" }, { kind: "folder" as const, id: "one" }, { kind: "server" as const, id: "a" }] };
  expect(serverRailServerIds(state)).toEqual(["e", "b", "c", "d", "a"]);
});
