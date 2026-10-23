import { act, renderHook } from "@/test/react-dom-harness"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import { catOf, projectChannelTreeDrop, resolveChannelTreeDrop, useChannelTree, type ChannelTreeDrop } from "./use-channel-tree"
import type { Category, Channel } from "@/lib/community/models/navigation"

const ch = (id: string, fields: Partial<Channel> = {}): Channel => ({ id, name: id, active: false, unread: false, ...fields })
const categories: Category[] = [
  { id: "opaque-a", name: "A", channels: [ch("text"), ch("forum", { type: "forum" }), ch("last")] },
  { id: "opaque-b", name: "B", channels: [ch("b1"), ch("b2")] },
  { id: "empty", name: "Empty", channels: [] },
  { id: "private", name: "Private", private: true, channels: [ch("secret")] },
  { id: "private2", name: "Private2", private: true, channels: [] },
]
const drop = (active: string, over: string, placement: ChannelTreeDrop["placement"], activeKind: "channel" | "category" = "channel", overKind: "channel" | "category" = "channel"): ChannelTreeDrop => ({ active: { id: active, kind: activeKind }, over: { id: over, kind: overKind }, placement })
const treeFrom = (rows = categories) => renderHook(() => useChannelTree(rows)).result.current
const channelIds = (tree: ReturnType<typeof useChannelTree>, event: ChannelTreeDrop) => {
  const result = projectChannelTreeDrop(tree, event)
  expect(result).not.toBeNull()
  return result && "channelIds" in result ? result : null
}

describe("explicit channel tree instructions", () => {
  it("uses one container append instruction for the final row's after edge", () => {
    const tree = treeFrom()
    expect(resolveChannelTreeDrop(tree, drop("text", "last", "after"))).toEqual(drop("text", "opaque-a", "append", "channel", "category"))
    expect(resolveChannelTreeDrop(tree, drop("text", "b2", "after"))).toEqual(drop("text", "opaque-b", "append", "channel", "category"))
    expect(resolveChannelTreeDrop(tree, drop("last", "text", "after"))).toEqual(drop("last", "text", "after"))
    expect(resolveChannelTreeDrop(tree, drop("secret", "last", "after"))).toBeNull()
    expect(resolveChannelTreeDrop(tree, drop("last", "opaque-a", "append", "channel", "category"))).toBeNull()
    expect(resolveChannelTreeDrop(tree, drop("text", "missing", "after"))).toBeNull()
  })
  it("uses the pointer edge for mixed text/forum insertion in either direction", () => {
    const tree = treeFrom()
    expect(channelIds(tree, drop("text", "last", "before"))?.channelIds.slice(0, 3)).toEqual(["forum", "text", "last"])
    expect(channelIds(tree, drop("text", "last", "after"))?.channelIds.slice(0, 3)).toEqual(["forum", "last", "text"])
    expect(channelIds(tree, drop("last", "text", "before"))?.channelIds.slice(0, 3)).toEqual(["last", "text", "forum"])
    expect(channelIds(tree, drop("last", "text", "after"))?.channelIds.slice(0, 3)).toEqual(["text", "last", "forum"])
    expect(tree.order["opaque-a"].map((row) => row.id)).toEqual(["text", "forum", "last"])
  })
  it("projects category blocks before or after without persisting synthetic or pending categories", () => {
    const tree = treeFrom([...categories, { id: "pending", name: "Pending", pending: true, channels: [] }])
    expect(projectChannelTreeDrop(tree, drop("opaque-a", "private", "before", "category", "category"))).toEqual({ categoryIds: ["opaque-b", "empty", "opaque-a", "private", "private2"] })
    expect(projectChannelTreeDrop(tree, drop("opaque-a", "private", "after", "category", "category"))).toEqual({ categoryIds: ["opaque-b", "empty", "private", "opaque-a", "private2"] })
    expect(projectChannelTreeDrop(tree, drop("pending", "opaque-a", "before", "category", "category"))).toBeNull()
    expect(projectChannelTreeDrop(tree, drop("opaque-a", UNCATEGORIZED_CATEGORY_ID, "before", "category", "category"))).toBeNull()
  })
  it("produces one category move plus the final order for an exact cross-category insertion", () => {
    const tree = treeFrom()
    expect(channelIds(tree, drop("text", "b1", "after"))).toEqual({ channelIds: ["forum", "last", "b1", "text", "b2", "secret"], move: { channelId: "text", categoryId: "opaque-b" } })
    expect(channelIds(tree, drop("text", "opaque-b", "append", "channel", "category"))?.channelIds).toEqual(["forum", "last", "b1", "b2", "text", "secret"])
    expect(channelIds(tree, drop("text", "empty", "append", "channel", "category"))?.move).toEqual({ channelId: "text", categoryId: "empty" })
  })
  it("supports an empty root bucket and private/private without crossing privacy", () => {
    const tree = treeFrom()
    expect(tree.order[UNCATEGORIZED_CATEGORY_ID]).toEqual([])
    expect(channelIds(tree, drop("text", UNCATEGORIZED_CATEGORY_ID, "append", "channel", "category"))?.move).toEqual({ channelId: "text", categoryId: null })
    expect(channelIds(tree, drop("secret", "private2", "append", "channel", "category"))?.move).toEqual({ channelId: "secret", categoryId: "private2" })
    expect(projectChannelTreeDrop(tree, drop("text", "private2", "append", "channel", "category"))).toBeNull()
    expect(projectChannelTreeDrop(tree, drop("secret", UNCATEGORIZED_CATEGORY_ID, "append", "channel", "category"))).toBeNull()
  })
  it("does not save an unchanged adjacency, unchanged append, self or malformed identity", () => {
    const tree = treeFrom()
    for (const event of [drop("text", "forum", "before"), drop("forum", "text", "after"), drop("last", "opaque-a", "append", "channel", "category"), drop("text", "text", "after"), drop("missing", "text", "after"), drop("opaque-a", "text", "after", "category"), drop("text", "opaque-b", "after", "category", "category"), drop("text", "b1", "append")]) {
      expect(projectChannelTreeDrop(tree, event)).toBeNull()
    }
  })
  it("rejects pending source/target rows and categories before producing a command", () => {
    const tree = treeFrom([{ id: "a", name: "A", channels: [ch("ready"), ch("pending", { pending: true })] }, { id: "pending-cat", name: "Pending", pending: true, channels: [ch("inside")] }])
    for (const event of [drop("pending", "ready", "after"), drop("ready", "pending", "after"), drop("ready", "pending-cat", "append", "channel", "category"), drop("inside", "ready", "after")]) expect(projectChannelTreeDrop(tree, event)).toBeNull()
  })
})

describe("canonical channel tree ownership", () => {
  it("shows canonical optimistic order and its rollback without retaining a local order", () => {
    const view = renderHook(({ rows }) => useChannelTree(rows), { initialProps: { rows: categories } })
    act(() => view.result.current.toggleCat("opaque-b"))
    const moved = categories.map((category) => category.id === "opaque-a" ? { ...category, channels: [ch("last"), ch("text"), ch("forum")] } : category)
    view.rerender({ rows: moved })
    expect(view.result.current.order["opaque-a"].map((row) => row.id)).toEqual(["last", "text", "forum"])
    view.rerender({ rows: categories })
    expect(view.result.current.order["opaque-a"].map((row) => row.id)).toEqual(["text", "forum", "last"])
    expect(view.result.current.collapsed).toEqual(new Set(["opaque-b"]))
  })
  it("takes every field from the canonical row while keeping disclosure state", () => {
    const view = renderHook(({ rows }) => useChannelTree(rows), { initialProps: { rows: categories } })
    act(() => view.result.current.toggleCat("opaque-a"))
    const changed = ch("text", { name: "renamed", unread: true, muted: true, type: "forum", pending: true, creatorId: "creator" })
    view.rerender({ rows: categories.map((category) => category.id === "opaque-a" ? { ...category, channels: [changed] } : category) })
    expect(view.result.current.order["opaque-a"][0]).toBe(changed)
    expect(view.result.current.collapsed.has("opaque-a")).toBe(true)
    expect(catOf("text", view.result.current.order)).toBe("opaque-a")
    expect(catOf("missing", view.result.current.order)).toBeUndefined()
  })
  it("does not schedule state updates for equivalent reallocated category arrays", () => {
    let renders = 0
    const view = renderHook(() => { renders++; return useChannelTree(categories.map((category) => ({ ...category, channels: [...category.channels] }))) })
    act(() => view.result.current.toggleCat("opaque-a"))
    view.rerender()
    expect(renders).toBe(3)
    expect(view.result.current.collapsed).toEqual(new Set(["opaque-a"]))
  })
  it("does not duplicate a real uncategorized bucket", () => {
    const root = { id: UNCATEGORIZED_CATEGORY_ID, name: "", channels: [ch("root")] }
    const tree = treeFrom([root, ...categories])
    expect(tree.catOrder.filter((id) => id === UNCATEGORIZED_CATEGORY_ID)).toHaveLength(1)
    expect(tree.order[UNCATEGORIZED_CATEGORY_ID]).toBe(root.channels)
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
