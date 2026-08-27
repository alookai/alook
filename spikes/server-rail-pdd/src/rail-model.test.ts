import { describe, expect, it } from "vitest"
import {
  MAX_FOLDERS,
  accessibleMoveLabel,
  cloneState,
  commitInstruction,
  planPersistence,
  stateErrors,
  visibleTopLevelServers,
  type RailInstruction,
  type RailState,
} from "./rail-model"

function fixture(): RailState {
  return {
    serverOrder: ["a", "b", "c", "d", "e", "f"],
    folderOrder: ["one", "two"],
    folders: { one: ["c", "d"], two: ["e"] },
    expanded: ["one"],
  }
}

function apply(instruction: RailInstruction, state = fixture()) {
  return commitInstruction(state, instruction)
}

describe("normalized server rail reducer", () => {
  it("keeps global membership order while deriving visible top-level servers", () => {
    expect(visibleTopLevelServers(fixture())).toEqual(["a", "b", "f"])
    expect(stateErrors(fixture())).toEqual([])
  })

  it("reorders top-level servers with the full membership sequence", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "reorder-after",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    }
    const result = commitInstruction(before, instruction)
    expect(result.applied).toBe(true)
    expect(result.state.serverOrder).toEqual(["b", "a", "c", "d", "e", "f"])
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "reorder-servers", serverIds: ["b", "a", "c", "d", "e", "f"] },
    ])

    const beforeResult = apply({
      operation: "reorder-before",
      source: { kind: "server", id: "f" },
      target: { kind: "server", id: "a" },
    })
    expect(beforeResult.state.serverOrder).toEqual(["f", "a", "b", "c", "d", "e"])
  })

  it("reorders folders without inventing cross-kind positions", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "reorder-before",
      source: { kind: "folder", id: "two" },
      target: { kind: "folder", id: "one" },
    }
    const result = commitInstruction(before, instruction)
    expect(result.state.folderOrder).toEqual(["two", "one"])
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "reorder-folders", folderIds: ["two", "one"] },
    ])

    expect(apply({
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "folder", id: "one" },
    })).toMatchObject({ applied: false, reason: "server and folder orders cannot interleave" })
  })

  it("reorders within a folder with one folder update", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "reorder-before",
      source: { kind: "server", id: "d" },
      target: { kind: "server", id: "c" },
    }
    const result = commitInstruction(before, instruction)
    expect(result.state.folders.one).toEqual(["d", "c"])
    expect(result.state.serverOrder).toEqual(before.serverOrder)
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "update-folder", folderId: "one", serverIds: ["d", "c"] },
    ])
  })

  it("moves a top-level server into a folder and expands the destination", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "folder", id: "two" },
    }
    const result = commitInstruction(before, instruction)
    expect(result.state.folders.two).toEqual(["e", "a"])
    expect(result.state.expanded).toEqual(["one", "two"])
    expect(result.state.serverOrder).toEqual(before.serverOrder)
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "update-folder", folderId: "two", serverIds: ["e", "a"] },
    ])
  })

  it("moves a server between folders with the two necessary updates", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "reorder-after",
      source: { kind: "server", id: "c" },
      target: { kind: "server", id: "e" },
    }
    const result = commitInstruction(before, instruction)
    expect(result.state.folders).toEqual({ one: ["d"], two: ["e", "c"] })
    expect(result.state.expanded).toEqual(["one", "two"])
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "update-folder", folderId: "one", serverIds: ["d"] },
      { type: "update-folder", folderId: "two", serverIds: ["e", "c"] },
    ])
  })

  it("moves the last folder server to rail and deletes the empty folder", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "reorder-before",
      source: { kind: "server", id: "e" },
      target: { kind: "server", id: "f" },
    }
    const result = commitInstruction(before, instruction)
    expect(visibleTopLevelServers(result.state)).toEqual(["a", "b", "e", "f"])
    expect(result.state.folderOrder).toEqual(["one"])
    expect(result.state.serverOrder).toEqual(["a", "b", "c", "d", "e", "f"])
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "update-folder", folderId: "two", serverIds: [] },
    ])
  })

  it("creates a temporary folder only from two top-level servers", () => {
    const before = fixture()
    const instruction: RailInstruction = {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
      newFolderId: "temp-1",
    }
    const result = commitInstruction(before, instruction)
    expect(result.state.folderOrder).toEqual(["one", "two", "temp-1"])
    expect(result.state.folders["temp-1"]).toEqual(["a", "b"])
    expect(planPersistence(before, result.state, instruction)).toEqual([
      { type: "create-folder", tempFolderId: "temp-1", serverIds: ["a", "b"] },
    ])

    expect(apply({
      ...instruction,
      source: { kind: "server", id: "c" },
    })).toMatchObject({
      applied: false,
      reason: "creating a folder requires two top-level servers",
    })
  })

  it("blocks new folders at the limit", () => {
    const state = fixture()
    state.folderOrder = Array.from({ length: MAX_FOLDERS }, (_, index) => `f${index}`)
    state.folders = Object.fromEntries(
      state.folderOrder.map((folderId, index) => [folderId, [`extra-${index}`]]),
    )
    state.serverOrder.push(...Object.values(state.folders).flat())
    state.expanded = []
    const result = commitInstruction(state, {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
      newFolderId: "too-many",
    })
    expect(result).toMatchObject({ applied: false, reason: "folder limit reached" })
  })

  it("treats preview, cancel, self drops, and invalid state as zero-write", () => {
    const before = fixture()
    const snapshot = cloneState(before)
    const self = apply({
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "a" },
    })
    expect(self.applied).toBe(false)
    expect(planPersistence(before, snapshot, {
      operation: "reorder-before",
      source: { kind: "server", id: "a" },
      target: { kind: "server", id: "b" },
    })).toEqual([])

    const invalid = fixture()
    invalid.folders.two.push("c")
    expect(commitInstruction(invalid, {
      operation: "combine",
      source: { kind: "server", id: "a" },
      target: { kind: "folder", id: "one" },
    })).toMatchObject({ applied: false, reason: "invalid start state" })
  })

  it("produces a literal accessible outcome", () => {
    expect(accessibleMoveLabel(fixture(), {
      operation: "reorder-after",
      source: { kind: "server", id: "c" },
      target: { kind: "server", id: "e" },
    })).toBe("Server c moved after server e from folder one")
  })
})
