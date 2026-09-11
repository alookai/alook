import React from "react"
import { act, render as rtlRender } from "@/test/react-dom-harness"
import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  catId,
  catOf,
  moveChannelAcrossCategories,
  reorderChannelsWithin,
  reorderCategories,
  mergeChannelMetadata,
  useChannelTree,
  type ChannelOrder,
} from "./use-channel-tree"
import type { Channel, Category } from "@/lib/community/models/navigation"
import type { DragEndEvent } from "@dnd-kit/core"

const ch = (id: string): Channel => ({ id, name: id, active: false, unread: false })
const category = (id: string, channels: Channel[]): Category => ({ id, name: id, channels })

type Tree = ReturnType<typeof useChannelTree>

function CaptureTree({ categories, onResult }: { categories: Category[]; onResult: (tree: Tree) => void }) {
  onResult(useChannelTree(categories))
  return null
}

let nextOwnerId = 0

function ScopedCaptureTree({
  scopeKey,
  categories,
  onResult,
}: {
  scopeKey: string
  categories: Category[]
  onResult: (tree: Tree, ownerId: number) => void
}) {
  return React.createElement(CaptureTreeOwner, {
    key: scopeKey,
    categories,
    onResult,
  })
}

function CaptureTreeOwner({
  categories,
  onResult,
}: {
  categories: Category[]
  onResult: (tree: Tree, ownerId: number) => void
}) {
  const [ownerId] = React.useState(() => ++nextOwnerId)
  onResult(useChannelTree(categories), ownerId)
  return null
}

async function renderTreeHook(categories: Category[]) {
  let current!: Tree
  await act(async () => {
    rtlRender(
      React.createElement(CaptureTree, { categories, onResult: (tree) => { current = tree } }),
    )
  })
  return {
    get current() {
      return current
    },
    async drag(callback: (tree: Tree) => void) {
      await act(async () => callback(current))
    },
  }
}

const dragEvent = (activeId: string, overId: string): DragEndEvent => ({
  active: { id: activeId },
  over: { id: overId },
}) as DragEndEvent

const order: ChannelOrder = {
  cat_A: [ch("a1"), ch("a2")],
  cat_B: [ch("b1"), ch("b2"), ch("b3")],
}

describe("id helpers", () => {
  it("keeps persisted category ids unchanged for dnd", () => {
    expect(catId("cat_A")).toBe("cat_A")
    expect(catId("5vg7bs")).toBe("5vg7bs")
  })
})

describe("catOf", () => {
  it("resolves the category holding a channel", () => {
    expect(catOf("a2", order)).toBe("cat_A")
    expect(catOf("b3", order)).toBe("cat_B")
  })
  it("resolves a category id to itself", () => {
    expect(catOf("cat_B", order)).toBe("cat_B")
  })
  it("resolves an opaque category id from the actual tree keys", () => {
    const opaqueOrder = { "5vg7bs": [ch("a1")] }
    expect(catOf("5vg7bs", opaqueOrder)).toBe("5vg7bs")
  })
  it("returns undefined for an unknown channel", () => {
    expect(catOf("zzz", order)).toBeUndefined()
  })
})

describe("moveChannelAcrossCategories", () => {
  it("relocates a channel into another category at the over index", () => {
    const next = moveChannelAcrossCategories(order, "a1", "b2")
    expect(next.cat_A.map((c) => c.id)).toEqual(["a2"])
    expect(next.cat_B.map((c) => c.id)).toEqual(["b1", "a1", "b2", "b3"])
  })
  it("is a no-op within the same category", () => {
    expect(moveChannelAcrossCategories(order, "a1", "a2")).toBe(order)
  })
  it("is a no-op for a missing channel", () => {
    expect(moveChannelAcrossCategories(order, "zzz", "b1")).toBe(order)
  })
})

describe("reorderChannelsWithin", () => {
  it("reorders channels inside one category", () => {
    const next = reorderChannelsWithin(order, "b1", "b3")
    expect(next.cat_B.map((c) => c.id)).toEqual(["b2", "b3", "b1"])
  })
  it("is a no-op when over is in a different category", () => {
    expect(reorderChannelsWithin(order, "a1", "b1")).toBe(order)
  })
})

// Regression: channel-sidebar's drop handler builds the reorder-PATCH payload
// from the SETTLED order (reorderChannelsWithin applied synchronously), not the
// stale pre-drop `order` closure. Same-category reorders previously PATCHed the
// old sequence → positions rewritten unchanged → reorder didn't persist across
// refresh. This pins that the payload derivation reflects the moved order.
describe("reorder-PATCH payload derivation (channel-sidebar drop handler)", () => {
  const catOrder = ["cat_A", "cat_B"]
  const payloadFrom = (o: ChannelOrder) =>
    catOrder.flatMap((cat) => (o[cat] ?? []).map((c) => c.id))

  it("same-category drop: payload reflects the moved order, not the pre-drop order", () => {
    // Pre-drop order would yield b1,b2,b3 — the stale bug. Settled must move b1 past b3.
    const settled = reorderChannelsWithin(order, "b1", "b3")
    expect(payloadFrom(settled)).toEqual(["a1", "a2", "b2", "b3", "b1"])
    expect(payloadFrom(settled)).not.toEqual(payloadFrom(order))
  })

  it("re-settling an already-cross-category-settled order is idempotent for the payload", () => {
    // Cross-category is settled by onDragOver first; applying reorderChannelsWithin
    // to place it at the drop target within the destination must not corrupt it.
    const moved = moveChannelAcrossCategories(order, "a1", "b2") // a1 → cat_B before b2
    const settled = reorderChannelsWithin(moved, "a1", "b2")
    expect(payloadFrom(settled)).toContain("a1")
    // a1 left cat_A; cat_A now only a2.
    expect(settled.cat_A.map((c) => c.id)).toEqual(["a2"])
  })
})

describe("reorderCategories", () => {
  it("reorders the category id list", () => {
    expect(reorderCategories(["cat_A", "cat_B", "cat_C"], "cat_A", "cat_C")).toEqual(["cat_B", "cat_C", "cat_A"])
  })
  it("returns the input when a category is missing", () => {
    const cats = ["cat_A", "cat_B"]
    expect(reorderCategories(cats, "cat_Z", "cat_A")).toBe(cats)
  })
})

describe("useChannelTree opaque category drag callbacks", () => {
  const categories = [
    category("5vg7bs", [ch("a1"), ch("a2")]),
    category("9qsh2k", [ch("b1"), ch("b2")]),
  ]

  it("ignores category drag-over instead of moving a channel", async () => {
    const hook = await renderTreeHook(categories)
    const before = hook.current.order

    await hook.drag((tree) => tree.onDragOver(dragEvent("5vg7bs", "b1")))

    expect(hook.current.order).toBe(before)
    expect(hook.current.order["5vg7bs"].map((channel) => channel.id)).toEqual(["a1", "a2"])
    expect(hook.current.order["9qsh2k"].map((channel) => channel.id)).toEqual(["b1", "b2"])
  })

  it("reorders opaque categories through the hook drop callback", async () => {
    const hook = await renderTreeHook(categories)

    await hook.drag((tree) => tree.onDragEnd(dragEvent("5vg7bs", "9qsh2k")))

    expect(hook.current.catOrder).toEqual(["9qsh2k", "5vg7bs"])
  })

  it("treats an opaque category dropped over a channel as a no-op", async () => {
    const hook = await renderTreeHook(categories)
    const beforeOrder = hook.current.order
    const beforeCatOrder = hook.current.catOrder

    await hook.drag((tree) => tree.onDragEnd(dragEvent("5vg7bs", "b1")))

    expect(hook.current.order).toBe(beforeOrder)
    expect(hook.current.catOrder).toBe(beforeCatOrder)
  })
})

describe("useChannelTree scope ownership", () => {
  const categoriesA: Category[] = [
    {
      id: "cat_A",
      name: "Alpha",
      private: true,
      pending: true,
      creatorId: "owner_A",
      channels: [ch("a1"), { ...ch("tmp_A"), pending: true }],
    },
    category("cat_A2", [ch("a2")]),
  ]
  const categoriesB: Category[] = [
    {
      id: "cat_B",
      name: "Beta",
      private: false,
      pending: false,
      creatorId: "owner_B",
      channels: [ch("b1"), ch("b2")],
    },
  ]

  it("preserves the seven state groups and callback owner under one stable key", async () => {
    nextOwnerId = 0
    let current!: Tree
    let ownerId = 0
    const onResult = (tree: Tree, id: number) => {
      current = tree
      ownerId = id
    }
    const renderer = rtlRender(React.createElement(ScopedCaptureTree, {
      scopeKey: "server:A",
      categories: categoriesA,
      onResult,
    }))
    const initialOwnerId = ownerId
    const initialToggle = current.toggleCat

    await act(async () => current.toggleCat("cat_A"))
    await act(async () => current.onDragOver(dragEvent("a2", "a1")))
    const movedOrder = current.order

    renderer.rerender(React.createElement(ScopedCaptureTree, {
      scopeKey: "server:A",
      categories: categoriesA,
      onResult,
    }))

    expect(ownerId).toBe(initialOwnerId)
    expect(current.collapsed).toEqual(new Set(["cat_A"]))
    expect(current.order).toBe(movedOrder)
    expect(current.catOrder).toEqual(["cat_A", "cat_A2"])
    expect(current.catNames).toMatchObject({ cat_A: "Alpha", cat_A2: "cat_A2" })
    expect(current.catPrivate.cat_A).toBe(true)
    expect(current.catPending.cat_A).toBe(true)
    expect(current.catCreators.cat_A).toBe("owner_A")
    expect(current.toggleCat).toBe(initialToggle)
  })

  it("initializes the first render of a new key atomically from only that scope", async () => {
    nextOwnerId = 0
    const samples: Array<{ tree: Tree; ownerId: number }> = []
    const onResult = (tree: Tree, ownerId: number) => samples.push({ tree, ownerId })
    const renderer = rtlRender(React.createElement(ScopedCaptureTree, {
      scopeKey: "server:A",
      categories: categoriesA,
      onResult,
    }))

    const current = samples.at(-1)!.tree
    await act(async () => current.toggleCat("cat_A"))
    await act(async () => current.onDragOver(dragEvent("a2", "a1")))
    const ownerA = samples.at(-1)!.ownerId
    samples.length = 0

    renderer.rerender(React.createElement(ScopedCaptureTree, {
      scopeKey: "server:B",
      categories: categoriesB,
      onResult,
    }))

    const firstB = samples[0]
    expect(firstB.ownerId).not.toBe(ownerA)
    expect(firstB.tree.collapsed).toEqual(new Set())
    expect(firstB.tree.catOrder).toEqual(["cat_B"])
    expect(Object.keys(firstB.tree.order)).toEqual(["cat_B"])
    expect(firstB.tree.order.cat_B.map((channel) => channel.id)).toEqual(["b1", "b2"])
    expect(firstB.tree.catNames).toEqual({ cat_B: "Beta" })
    expect(firstB.tree.catPrivate).toEqual({ cat_B: false })
    expect(firstB.tree.catPending).toEqual({ cat_B: false })
    expect(firstB.tree.catCreators).toEqual({ cat_B: "owner_B" })
    expect(JSON.stringify(firstB.tree)).not.toContain("tmp_A")

    samples.length = 0
    renderer.rerender(React.createElement(ScopedCaptureTree, {
      scopeKey: "server:A",
      categories: categoriesA,
      onResult,
    }))
    expect(samples[0].ownerId).not.toBe(firstB.ownerId)
    expect(samples[0].tree.collapsed).toEqual(new Set())
    expect(samples[0].tree.order.cat_A.map((channel) => channel.id)).toEqual(["a1", "tmp_A"])
  })
})

// Regression: the sync effect's id-set early-return silently swallowed
// metadata-only updates (unread/name) — see "The useChannelTree gap" in
// plans/community-unread-indicators.md.
describe("mergeChannelMetadata", () => {
  const cat = (id: string, channels: Channel[]): Category => ({ id, name: id, channels })

  it("flips an unread flag while ids are unchanged", () => {
    const result = mergeChannelMetadata(order, [
      cat("cat_A", [ch("a1"), { ...ch("a2"), unread: true }]),
      cat("cat_B", [ch("b1"), ch("b2"), ch("b3")]),
    ])
    expect(result.changed).toBe(true)
    expect(result.next.cat_A.find((c) => c.id === "a2")?.unread).toBe(true)
    // Untouched sibling channel keeps the same object reference.
    expect(result.next.cat_A.find((c) => c.id === "a1")).toBe(order.cat_A[0])
  })

  it("follows optimistic, normalized, and rollback names while ids and order stay unchanged", () => {
    const incoming = (name: string) => [
      cat("cat_A", [ch("a1"), { ...ch("a2"), name }]),
      cat("cat_B", [ch("b1"), ch("b2"), ch("b3")]),
    ]
    const optimistic = mergeChannelMetadata(order, incoming("General Chat"))
    const normalized = mergeChannelMetadata(optimistic.next, incoming("General-Chat"))
    const rolledBack = mergeChannelMetadata(optimistic.next, incoming("a2"))

    expect(optimistic.next.cat_A.find((c) => c.id === "a2")?.name).toBe("General Chat")
    expect(normalized.next.cat_A.find((c) => c.id === "a2")?.name).toBe("General-Chat")
    expect(rolledBack.next.cat_A.find((c) => c.id === "a2")?.name).toBe("a2")
    expect(normalized.next.cat_A.map((channel) => channel.id)).toEqual(["a1", "a2"])
    expect(normalized.next.cat_B.map((channel) => channel.id)).toEqual(["b1", "b2", "b3"])
  })

  it("preserves category/channel order — only rewrites the changed field", () => {
    const result = mergeChannelMetadata(order, [
      cat("cat_A", [ch("a1"), { ...ch("a2"), unread: true }]),
      cat("cat_B", [ch("b1"), ch("b2"), ch("b3")]),
    ])
    expect(Object.keys(result.next)).toEqual(Object.keys(order))
    expect(result.next.cat_B.map((c) => c.id)).toEqual(order.cat_B.map((c) => c.id))
    // Every field on the changed channel other than the diffed ones is preserved.
    expect(result.next.cat_A.find((c) => c.id === "a2")).toMatchObject({ id: "a2", active: false })
  })

  it("is a no-op (same reference, changed: false) when nothing differs", () => {
    const result = mergeChannelMetadata(order, [
      cat("cat_A", [ch("a1"), ch("a2")]),
      cat("cat_B", [ch("b1"), ch("b2"), ch("b3")]),
    ])
    expect(result.changed).toBe(false)
    expect(result.next).toBe(order)
  })

  // An optimistic pending row that survives an id-set-unchanged metadata merge
  // (e.g. a sibling WS unread patch) must keep its `pending` flag — the merge
  // spreads the existing row and only overwrites unread/name.
  it("preserves the pending flag when only unread changes underneath it", () => {
    const pendingOrder: ChannelOrder = {
      cat_A: [{ ...ch("tmp_ch_x"), pending: true }],
    }
    const result = mergeChannelMetadata(pendingOrder, [
      cat("cat_A", [{ ...ch("tmp_ch_x"), unread: true }]),
    ])
    expect(result.changed).toBe(true)
    const row = result.next.cat_A.find((c) => c.id === "tmp_ch_x")
    expect(row?.pending).toBe(true)
    expect(row?.unread).toBe(true)
  })
})

describe("ChannelSidebar rename ownership", () => {
  it("submits through the external mutation without eagerly mutating the local tree", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/channels/channel-sidebar.tsx",
    ), "utf8")
    expect(source).toContain("onCreate={({ name }) => { onRenameChannel?.(dialog.id, name) }}")
    expect(source).not.toContain("renameChannel(dialog.id, name)")
  })

  it("keeps title, same-server refs, and member UI on reconciled server detail", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/channels/channel-route.tsx",
    ), "utf8")
    expect(source).toContain("topLevelName: channelInServer?.name")
    expect(source).toContain(".map((channel) => toChannelRefCandidate(currentServer, channel))")
    expect(source).toContain("useChannelMemberViewModel({")
    expect(source).toContain("channelName,\n    currentServer,")
  })
})
