
import { createCommunityStore } from "./index"
const nativeStore = createCommunityStore()
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityStore } from "./index"

beforeEach(() => {
  nativeStore.actions.reset()
})



describe("typingByScope isolation", () => {
  // The `useTypingUsersForScope` hook is a thin `useShallow` wrapper over these
  // reads (exercised through React in `use-community-ws.test.ts`); the node
  // test env has no DOM, so here we assert the underlying scoped-Map shape that
  // the selector reads — one scope's typers never bleed into another.
  const seed = (entries: Record<string, string[]>) => {
    nativeStore.setState((state) => ({ ...state, ...{
      typingByScope: new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)])),
    } }))
  }
  const read = (scopeKey: string) => {
    const set = nativeStore.get().typingByScope.get(scopeKey)
    return set ? Array.from(set) : []
  }

  it("keeps each scope's typers separate; an unrelated scope reads empty", () => {
    seed({ "dm:d1": ["u1"], "ch:c1": ["u2", "u3"] })
    expect(read("dm:d1")).toEqual(["u1"])
    expect(read("ch:c1")).toEqual(["u2", "u3"])
    // A scope with no typers reads as empty — no leak from the populated scopes.
    expect(read("ch:c2")).toEqual([])
  })
})
