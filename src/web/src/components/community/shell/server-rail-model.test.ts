import { describe, expect, it } from "vitest"
import {
  commitRailInstruction,
  planRailPersistence,
  railInstructionIsAvailable,
  railOperationAvailability,
  railTopLevel,
  railStateFromData,
  railStateErrors,
  visibleTopLevelServers,
  type RailState,
} from "@/lib/community/server-rail-model"

function fixture(): RailState {
  return {
    serverIds: ["a", "b", "c", "d", "e", "f"],
    folderIds: ["one", "two"],
    folders: { one: ["c", "d"], two: ["e"] },
    expanded: ["one"],
  }
}

describe("server rail normalized reducer", () => {
  it.each(["combine", "append", "reorder-after"] as const)("preserves an existing destination's disclosure after %s", (operation) => {
    for (const open of [false, true]) {
      const before = fixture()
      if (open) before.expanded.push("two")
      const source = { kind: "server", id: "a" } as const
      const result = commitRailInstruction(before, operation === "append"
        ? { operation, source, target: { kind: "folder-content", id: "two" } }
        : { operation, source, target: operation === "combine" ? { kind: "folder", id: "two" } : { kind: "server", id: "e" } })
      expect(result.applied).toBe(true)
      if (result.applied) {
        expect(result.state.expanded).toEqual(before.expanded)
        expect(result.state.folders.two).toEqual(["e", "a"])
      }
    }
  })
  it("moves a folder's last member into its own root gap at the former folder position", () => {
    const result = commitRailInstruction(fixture(), { operation: "reorder-before", source: { kind: "server", id: "e" }, target: { kind: "folder", id: "two" } })
    expect(result.applied).toBe(true)
    if (!result.applied) return
    expect(result.state.folders.two).toBeUndefined()
    expect(railTopLevel(result.state).map((entry) => entry.id)).toEqual(["a", "b", "f", "one", "e"])
    expect(result.commands.map((command) => command.kind)).toEqual(["delete-folder", "reorder-top-level"])
  })
  it("appends an existing member on its own folder header and ignores an already-last member", () => {
    const result = commitRailInstruction(fixture(), { operation: "combine", source: { kind: "server", id: "c" }, target: { kind: "folder", id: "one" } })
    expect(result.applied).toBe(true)
    if (!result.applied) return
    expect(result.state.folders.one).toEqual(["d", "c"])
    expect(result.commands).toEqual([{ kind: "replace-folder-items", folderId: "one", serverIds: ["d", "c"] }])
    expect(commitRailInstruction(result.state, { operation: "combine", source: { kind: "server", id: "c" }, target: { kind: "folder", id: "one" } })).toMatchObject({ applied: false, reason: "instruction is a no-op" })
  })
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
      serverIds: ["a", "b"],
      folderIds: ["Z-binary-first", "valid"],
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
    expect(result.state.serverIds).toEqual(fixture().serverIds)
    expect(railTopLevel(result.state).map((entry) => entry.id)).toEqual(["b", "a", "f", "one", "two"])
    expect(result.commands).toEqual([
      { kind: "reorder-top-level", entries: railTopLevel(result.state) },
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
    expect(result.state.folderIds).toEqual(["one"])
    expect(result.commands).toEqual([{ kind: "delete-folder", folderId: "two" }, { kind: "reorder-top-level", entries: railTopLevel(result.state) }])
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
      serverIds: ["b", "a"],
    }, { kind: "reorder-top-level", entries: railTopLevel(result.state) }])
  })

  it("plans folder reorder separately and treats no-op as zero-write", () => {
    const before = fixture()
    const after = { ...fixture(), folderIds: ["two", "one"] }
    expect(planRailPersistence(before, after)).toEqual([
      { kind: "reorder-top-level", entries: railTopLevel(after) },
    ])
    expect(commitRailInstruction(before, {
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "a" },
    })).toMatchObject({ applied: false })
  })

  it("allows mixed reorder and rejects duplicate-folder membership", () => {
    expect(commitRailInstruction(fixture(), {
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "folder", id: "one" },
    })).toMatchObject({ applied: true })
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
    )).toEqual({ "reorder-before": true, "reorder-after": true, combine: true })
    expect(railOperationAvailability(
      fixture(),
      { kind: "server", id: "a" },
      { kind: "folder", id: "one" },
    )).toEqual({ "reorder-before": true, "reorder-after": true, combine: true })
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
    state.folderIds.push("__rail_preview_folder__")
    state.folders.__rail_preview_folder__ = ["f"]

    expect(railInstructionIsAvailable(state, {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    })).toBe(true)
  })
})

it("creates directly from a nested server within the bounded command batch", () => {
  const result = commitRailInstruction(fixture(), { operation: "combine", source: { kind: "server", id: "c" }, target: { kind: "server", id: "a" }, newFolderId: "new" })
  expect(result.applied).toBe(true)
  if (!result.applied) return
  expect(result.state.folders.one).toEqual(["d"])
  expect(result.state.folders.new).toEqual(["a", "c"])
  expect(result.commands.map((command) => command.kind)).toEqual(["replace-folder-items", "create-folder", "reorder-top-level"])
  expect(railTopLevel(result.state)[0]).toEqual({ kind: "folder", id: "new" })
})
it("appends a nested server to root and deletes only the emptied folder", () => {
  const result = commitRailInstruction(fixture(), { operation: "append", source: { kind: "server", id: "e" }, target: { kind: "root", id: "root" } })
  expect(result.applied).toBe(true)
  if (!result.applied) return
  expect(result.state.folders.two).toBeUndefined()
  expect(result.state.folders.one).toEqual(["c", "d"])
  expect(railTopLevel(result.state).at(-1)).toEqual({ kind: "server", id: "e" })
  expect(result.commands).toHaveLength(2)
})
it("keeps ten folders usable and refuses only a net eleventh folder", () => {
  const state: RailState = { serverIds: ["a", "b", ...Array.from({ length: 11 }, (_, i) => `s${i}`)], folderIds: Array.from({ length: 10 }, (_, i) => `f${i}`), folders: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i === 0 ? ["s0", "s10"] : [`s${i}`]])), expanded: [] }
  expect(commitRailInstruction(state, { operation: "combine", source: { kind: "server", id: "a" }, target: { kind: "server", id: "b" }, newFolderId: "extra" })).toMatchObject({ applied: false, reason: "folder limit reached" })
  const join = commitRailInstruction(state, { operation: "append", source: { kind: "server", id: "a" }, target: { kind: "folder-content", id: "f0" } })
  expect(join.applied).toBe(true)
  const replace = commitRailInstruction(state, { operation: "combine", source: { kind: "server", id: "s1" }, target: { kind: "server", id: "a" }, newFolderId: "replacement" })
  expect(replace.applied).toBe(true)
  if (replace.applied) expect(replace.state.folderIds).toHaveLength(10)
})
it("reorders folders between servers while preserving their contents", () => {
  const result = commitRailInstruction(fixture(), { operation: "reorder-after", source: { kind: "folder", id: "one" }, target: { kind: "server", id: "a" } })
  expect(result.applied).toBe(true)
  if (!result.applied) return
  expect(railTopLevel(result.state).map((entry) => entry.id)).toEqual(["a", "one", "b", "f", "two"])
  expect(result.state.folders).toEqual(fixture().folders)
  expect(result.commands.map((command) => command.kind)).toEqual(["reorder-top-level"])
})
