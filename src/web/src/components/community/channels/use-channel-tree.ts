"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useMemo } from "react"
import { UNCATEGORIZED_CATEGORY_ID, type ChannelCategoryMove } from "@alook/shared"
import type { Category, Channel } from "@/lib/community/models/navigation"

export type ChannelOrder = Record<string, Channel[]>
export type ChannelTreeEntity = { id: string; kind: "category" | "channel" }
export type ChannelTreeDrop = {
  active: ChannelTreeEntity
  over: ChannelTreeEntity
  placement: "before" | "after" | "append"
}
export type { ChannelCategoryMove } from "@alook/shared"
export type ChannelTreeCommit = { categoryIds: string[] } | { channelIds: string[]; move?: ChannelCategoryMove }

export function catOf(id: string, order: ChannelOrder): string | undefined {
  if (Object.hasOwn(order, id)) return id
  return Object.keys(order).find((cat) => order[cat].some((channel) => channel.id === id))
}

function insert<T>(rows: T[], value: T, target: T, placement: "before" | "after") {
  const next = rows.filter((row) => row !== value)
  const index = next.indexOf(target)
  if (index === -1) return rows
  next.splice(index + Number(placement === "after"), 0, value)
  return next
}
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index])

export function projectChannelTreeDrop(tree: Pick<ChannelTree, "catOrder" | "order" | "catNames" | "catPrivate" | "catPending">, drop: ChannelTreeDrop): ChannelTreeCommit | null {
  const { active, over, placement } = drop
  const { catOrder, order, catNames, catPrivate, catPending } = tree
  if (active.id === over.id) return null
  const from = catOf(active.id, order), to = catOf(over.id, order)
  if (!from || !to || catPending[from] || catPending[to]) return null
  if (active.kind === "category") {
    if (from !== active.id || to !== over.id || over.kind !== "category" || placement === "append" || !catNames[active.id] || !catNames[over.id]) return null
    const categoryIds = catOrder.filter((id) => catNames[id] && !catPending[id])
    const next = insert(categoryIds, active.id, over.id, placement)
    return sameIds(next, categoryIds) ? null : { categoryIds: next }
  }
  const moving = order[from].find((channel) => channel.id === active.id)
  if (!moving || moving.pending || catPrivate[from] !== catPrivate[to]) return null
  if (over.kind === "category" ? placement !== "append" : placement === "append") return null
  const target = over.kind === "channel" ? order[to].find((channel) => channel.id === over.id) : null
  if (over.kind === "channel" && (!target || target.pending)) return null
  const destination = order[to].filter((channel) => channel.id !== active.id)
  const index = target ? destination.indexOf(target) + Number(placement === "after") : destination.length
  destination.splice(index, 0, moving)
  if (from === to && sameIds(destination.map((channel) => channel.id), order[from].map((channel) => channel.id))) return null
  const settled = { ...order, [from]: order[from].filter((channel) => channel.id !== active.id), [to]: destination }
  return {
    channelIds: catOrder.flatMap((id) => (settled[id] ?? []).filter((channel) => !channel.pending).map((channel) => channel.id)),
    ...(from === to ? {} : { move: { channelId: active.id, categoryId: catNames[to] === "" ? null : to } }),
  }
}

export function resolveChannelTreeDrop(tree: ChannelTree, drop: ChannelTreeDrop): ChannelTreeDrop | null {
  let result = drop
  if (drop.active.kind === "channel" && drop.over.kind === "channel" && drop.placement === "after") {
    const categoryId = catOf(drop.over.id, tree.order)
    if (categoryId && tree.order[categoryId].filter((channel) => !channel.pending).at(-1)?.id === drop.over.id) result = { ...drop, over: { id: categoryId, kind: "category" }, placement: "append" }
  }
  return projectChannelTreeDrop(tree, result) ? result : null
}

export function useChannelTree(categories: Category[]) {
  const [collapsed, setCollapsed] = useAtom(useCreateAtom(new Set<string>()))
  const structure = useMemo(() => {
    const rows = categories.some((category) => category.name === "") ? categories
      : [...categories, { id: UNCATEGORIZED_CATEGORY_ID, name: "", private: false, channels: [] }]
    return {
      catOrder: rows.map((category) => category.id),
      order: Object.fromEntries(rows.map((category) => [category.id, category.channels])),
      catNames: Object.fromEntries(rows.map((category) => [category.id, category.name])),
      catPrivate: Object.fromEntries(rows.map((category) => [category.id, !!category.private])),
      catPending: Object.fromEntries(rows.map((category) => [category.id, !!category.pending])),
      catCreators: Object.fromEntries(rows.map((category) => [category.id, category.creatorId ?? null])),
    }
  }, [categories])
  const toggleCat = useCallback((id: string) => setCollapsed((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [setCollapsed])
  return { ...structure, collapsed, toggleCat }
}
export type ChannelTree = ReturnType<typeof useChannelTree>
