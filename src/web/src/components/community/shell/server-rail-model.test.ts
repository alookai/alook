import { describe, expect, it } from "vitest"
import {
  commitRailInstruction,
  planRailPersistence,
  railInstructionIsAvailable,
  railOperationAvailability,
  railStateFromData,
  railStateErrors,
  visibleTopLevelServers,
  type RailState,
} from "@/lib/community/server-rail-model"

function fixture(): RailState {
  return {
    serverOrder: ["a", "b", "c", "d", "e", "f"],
    folderOrder: ["one", "two"],
    folders: { one: ["c", "d"], two: ["e"] },
    expanded: ["one"],
  }
}

describe("server rail normalized reducer", () => {
  it("projects legacy dangling, empty, and duplicate folders with the server snapshot ordering", () => {
    const folder = (id: string, position: number, serverIds: string[]) => ({
      id,
      name: id,
      position,
      servers: serverIds.map((serverId) => ({ id: serverId, name: serverId, initial: serverId })),
    })
    expect(railStateFromData(["a", "b"], [
      folder("empty", 0, []),
      folder("a-locale-first", 1, ["a"]),
      folder("Z-binary-first", 1, ["a"]),
      folder("dangling", 2, ["foreign"]),
      folder("valid", 3, ["b"]),
    ], ["empty", "a-locale-first", "Z-binary-first", "valid"])).toEqual({
      serverOrder: ["a", "b"],
      folderOrder: ["Z-binary-first", "valid"],
      folders: { "Z-binary-first": ["a"], valid: ["b"] },
      expanded: ["Z-binary-first", "valid"],
    })
  })

  it("keeps the full membership order while deriving top-level servers", () => {
    expect(visibleTopLevelServers(fixture())).toEqual(["a", "b", "f"])
    expect(railStateErrors(fixture())).toEqual([])
  })

  it("reorders top-level servers with one complete command", () => {
    const result = commitRailInstruction(fixture(), {
      operation: "reorder-after",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    })
    expect(result).toMatchObject({ applied: true })
    if (!result.applied) return
    expect(result.state.serverOrder).toEqual(["b", "a", "c", "d", "e", "f"])
    expect(result.commands).toEqual([
      { kind: "reorder-servers", serverIds: ["b", "a", "c", "d", "e", "f"] },
    ])
  })

  it("moves between folders with exactly two replace commands", () => {
    const result = commitRailInstruction(fixture(), {
      operation: "reorder-after",
      source: { kind: "server", id: "c" },
      target: { kind: "server", id: "e" },
    })
    expect(result).toMatchObject({ applied: true })
    if (!result.applied) return
    expect(result.state.folders).toEqual({ one: ["d"], two: ["e", "c"] })
    expect(result.commands).toEqual([
      { kind: "replace-folder-items", folderId: "one", serverIds: ["d"] },
      { kind: "replace-folder-items", folderId: "two", serverIds: ["e", "c"] },
    ])
  })

  it("deletes an emptied folder and preserves the complete membership order", () => {
    const result = commitRailInstruction(fixture(), {
      operation: "reorder-before",
      source: { kind: "server", id: "e" },
      target: { kind: "server", id: "f" },
    })
    expect(result).toMatchObject({ applied: true })
    if (!result.applied) return
    expect(result.state.folderOrder).toEqual(["one"])
    expect(result.commands).toEqual([{ kind: "delete-folder", folderId: "two" }])
  })

  it("creates one temporary folder command from two top-level servers", () => {
    const result = commitRailInstruction(fixture(), {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
      newFolderId: "temp_one",
    })
    expect(result).toMatchObject({ applied: true })
    if (!result.applied) return
    expect(result.commands).toEqual([{
      kind: "create-folder",
      clientId: "temp_one",
      name: "Group",
      serverIds: ["a", "b"],
    }])
  })

  it("plans folder reorder separately and treats no-op as zero-write", () => {
    const before = fixture()
    const after = { ...fixture(), folderOrder: ["two", "one"] }
    expect(planRailPersistence(before, after)).toEqual([
      { kind: "reorder-folders", folderIds: ["two", "one"] },
    ])
    expect(commitRailInstruction(before, {
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "a" },
    })).toMatchObject({ applied: false })
  })

  it("rejects cross-kind reorder and duplicate-folder membership", () => {
    expect(commitRailInstruction(fixture(), {
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "folder", id: "one" },
    })).toMatchObject({ applied: false, reason: "server and folder orders cannot interleave" })
    const invalid = fixture()
    invalid.folders.two.push("c")
    expect(railStateErrors(invalid)).toContain("server c belongs to multiple folders")
  })

  it("derives exact state-aware operations for every sensor", () => {
    expect(railOperationAvailability(
      fixture(),
      { kind: "folder", id: "one" },
      { kind: "folder", id: "two" },
    )).toEqual({ "reorder-before": false, "reorder-after": true, combine: false })
    expect(railOperationAvailability(
      fixture(),
      { kind: "server", id: "c" },
      { kind: "folder", id: "one" },
    )).toEqual({ "reorder-before": false, "reorder-after": false, combine: false })
    expect(railOperationAvailability(
      fixture(),
      { kind: "server", id: "a" },
      { kind: "folder", id: "one" },
    )).toEqual({ "reorder-before": false, "reorder-after": false, combine: true })
    expect(railInstructionIsAvailable(fixture(), {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    })).toBe(true)
    expect(railInstructionIsAvailable(fixture(), {
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    })).toBe(false)
  })

  it("allocates a collision-free temporary id for server-combine previews", () => {
    const state = fixture()
    state.folderOrder.push("__rail_preview_folder__")
    state.folders.__rail_preview_folder__ = ["f"]

    expect(railInstructionIsAvailable(state, {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    })).toBe(true)
  })
})
