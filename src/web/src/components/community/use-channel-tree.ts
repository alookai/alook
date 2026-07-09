"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { arrayMove } from "@dnd-kit/sortable"
import type { DragEndEvent } from "@dnd-kit/core"
import type { Category, Channel } from "./_types"

// dnd ids: category ids are used directly (they already have a "cat_" prefix);
// channel ids are bare. We distinguish by checking the "cat_" prefix.
export const isCat = (id: string) => id.startsWith("cat_")
export const catId = (id: string) => id

export type ChannelOrder = Record<string, Channel[]>

/** Which category currently holds a channel id (or the category itself if `id` is a cat id). */
export function catOf(id: string, order: ChannelOrder): string | undefined {
  if (isCat(id)) return id
  return Object.keys(order).find((cat) => order[cat].some((c) => c.id === id))
}

/**
 * Live cross-category move while dragging a channel (channels can jump
 * categories). Returns a new order, or the input unchanged when the move doesn't
 * apply (same category, missing channel, etc.). Pure — exported for tests.
 */
export function moveChannelAcrossCategories(order: ChannelOrder, activeId: string, overId: string): ChannelOrder {
  const fromCat = catOf(activeId, order)
  const toCat = catOf(overId, order)
  if (!fromCat || !toCat || fromCat === toCat) return order
  const moving = order[fromCat].find((c) => c.id === activeId)
  if (!moving) return order
  const overIdx = order[toCat].findIndex((c) => c.id === overId)
  const insertAt = overIdx === -1 ? order[toCat].length : overIdx
  const nextTo = [...order[toCat]]
  nextTo.splice(insertAt, 0, moving)
  return {
    ...order,
    [fromCat]: order[fromCat].filter((c) => c.id !== activeId),
    [toCat]: nextTo,
  }
}

/** Settle channel order within the destination category on drop. Pure. */
export function reorderChannelsWithin(order: ChannelOrder, activeId: string, overId: string): ChannelOrder {
  const cat = catOf(activeId, order)
  if (!cat || !order[cat].some((c) => c.id === overId)) return order
  const from = order[cat].findIndex((c) => c.id === activeId)
  const to = order[cat].findIndex((c) => c.id === overId)
  if (from === -1 || to === -1) return order
  return { ...order, [cat]: arrayMove(order[cat], from, to) }
}

/** Remove a channel by id from whichever category holds it. Pure. */
function removeChannelFrom(order: ChannelOrder, id: string): ChannelOrder {
  const cat = catOf(id, order)
  if (!cat) return order
  return { ...order, [cat]: order[cat].filter((c) => c.id !== id) }
}

/** Reorder the category list itself. `activeCatId`/`overCatId` are category IDs. Pure. */
export function reorderCategories(catOrder: string[], activeCatId: string, overCatId: string): string[] {
  const from = catOrder.indexOf(activeCatId)
  const to = catOrder.indexOf(overCatId)
  if (from === -1 || to === -1) return catOrder
  return arrayMove(catOrder, from, to)
}


/**
 * Channel-sidebar dnd state: category order + per-category channel order, with
 * cross-category drag and collapse toggles. One DndContext drives both: categories
 * sort among themselves, channels sort across categories.
 */
export function useChannelTree(categories: Category[]) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [catOrder, setCatOrder] = useState<string[]>(() => categories.map((c) => c.id))
  const [order, setOrder] = useState<ChannelOrder>(() =>
    Object.fromEntries(categories.map((c) => [c.id, c.channels])),
  )
  // id → name lookup for display
  const [catNames, setCatNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(categories.map((c) => [c.id, c.name])),
  )
  // per-category privacy — default public; private restricts channel creation to admins
  const [catPrivate, setCatPrivate] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(categories.map((c) => [c.id, !!c.private])),
  )
  // per-category creator ID
  const [catCreators, setCatCreators] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(categories.map((c) => [c.id, c.creatorId ?? null])),
  )

  // Sync state when categories change from API (initial load or server switch)
  const prevCatsRef = useRef(categories)
  useEffect(() => {
    const prev = prevCatsRef.current
    prevCatsRef.current = categories
    if (categories === prev) return
    // Server-detail cleared on route change — collapse our derived state so the
    // sidebar's loading branch can render the skeleton instead of stale rows.
    if (categories.length === 0) {
      if (prev.length === 0) return
      setCatOrder([])
      setOrder({})
      setCatNames({})
      setCatPrivate({})
      setCatCreators({})
      return
    }
    // Compare both category IDs and channel IDs to detect any change
    const prevKey = prev.map((c) => `${c.id}:${c.channels.map((ch) => ch.id).join(",")}`).join("|")
    const nextKey = categories.map((c) => `${c.id}:${c.channels.map((ch) => ch.id).join(",")}`).join("|")
    if (prevKey === nextKey) return
    setCatOrder(categories.map((c) => c.id))
    setOrder(Object.fromEntries(categories.map((c) => [c.id, c.channels])))
    setCatNames(Object.fromEntries(categories.map((c) => [c.id, c.name])))
    setCatPrivate(Object.fromEntries(categories.map((c) => [c.id, !!c.private])))
    setCatCreators(Object.fromEntries(categories.map((c) => [c.id, c.creatorId ?? null])))
  }, [categories])

  const toggleCat = useCallback((id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    }), [])

  const removeChannel = useCallback((id: string) =>
    setOrder((prev) => removeChannelFrom(prev, id)), [])
  const renameChannel = useCallback((id: string, name: string) =>
    setOrder((prev) => {
      const cat = catOf(id, prev)
      if (!cat) return prev
      return { ...prev, [cat]: prev[cat].map((c) => c.id === id ? { ...c, name } : c) }
    }), [])
  const markRead = useCallback((id: string) =>
    setOrder((prev) => {
      const cat = catOf(id, prev)
      if (!cat) return prev
      return { ...prev, [cat]: prev[cat].map((c) => c.id === id ? { ...c, unread: false } : c) }
    }), [])
  // Refs for removeCategory — depends on current catNames/catOrder but we don't want
  // its identity to churn every time those change.
  const catNamesRef = useRef(catNames)
  catNamesRef.current = catNames
  const catOrderRef = useRef(catOrder)
  catOrderRef.current = catOrder
  const removeCategory = useCallback((id: string) => {
    const names = catNamesRef.current
    const order = catOrderRef.current
    const noneCatId = Object.keys(names).find((k) => names[k] === "") ?? order[0]
    setCatOrder((prev) => prev.filter((cid) => cid !== id))
    setOrder((prev) => {
      const { [id]: channels, ...rest } = prev
      if (channels?.length && noneCatId) rest[noneCatId] = [...(rest[noneCatId] ?? []), ...channels]
      return rest
    })
    setCatNames((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)))
    setCatPrivate((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)))
  }, [])
  const setCategoryPrivate = useCallback((id: string, isPrivate: boolean) =>
    setCatPrivate((prev) => ({ ...prev, [id]: isPrivate })), [])

  const onDragOver = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    if (!over || isCat(String(active.id))) return // category drags handled on drop
    setOrder((prev) => moveChannelAcrossCategories(prev, String(active.id), String(over.id)))
  }, [])

  const onDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    if (isCat(String(active.id)) && isCat(String(over.id))) {
      setCatOrder((prev) => reorderCategories(prev, String(active.id), String(over.id)))
      return
    }
    if (isCat(String(active.id))) return
    setOrder((prev) => reorderChannelsWithin(prev, String(active.id), String(over.id)))
  }, [])

  return useMemo(() => ({
    collapsed, catOrder, order, catNames, catPrivate, catCreators,
    toggleCat, removeChannel, renameChannel, markRead, removeCategory,
    setCategoryPrivate, onDragOver, onDragEnd,
  }), [
    collapsed, catOrder, order, catNames, catPrivate, catCreators,
    toggleCat, removeChannel, renameChannel, markRead, removeCategory,
    setCategoryPrivate, onDragOver, onDragEnd,
  ])
}

export type ChannelTree = ReturnType<typeof useChannelTree>
