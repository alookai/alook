"use client"


import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useMemo } from "react"
import { arrayMove } from "@dnd-kit/sortable"
import type { DragEndEvent } from "@dnd-kit/core"
import type { Category, Channel } from "@/lib/community/models/navigation"

// DnD keeps the persisted opaque IDs unchanged. Category identity comes from
// membership in `catOrder` / `order`, never from an ID prefix.
export const catId = (id: string) => id

export type ChannelOrder = Record<string, Channel[]>

/** Which category currently holds a channel id (or the category itself if `id` is an order key). */
export function catOf(id: string, order: ChannelOrder): string | undefined {
  if (Object.hasOwn(order, id)) return id
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

/**
 * Merge metadata-only field changes (`unread`, `name`) from the incoming
 * `categories` prop into the existing per-category `order` state, keyed by
 * channel id. Used by the sync effect when the channel/category *id set* is
 * unchanged but a field like `unread` still needs to reach the render tree —
 * preserves drag order/collapse state by only ever touching the matched
 * channel's fields, never reshuffling arrays. Pure — exported for tests.
 */
export function mergeChannelMetadata(
  order: ChannelOrder,
  categories: Category[],
): { next: ChannelOrder; changed: boolean } {
  const incoming = new Map<string, Channel>()
  for (const cat of categories) {
    for (const ch of cat.channels) incoming.set(ch.id, ch)
  }
  let changed = false
  const next: ChannelOrder = {}
  for (const [catId, channels] of Object.entries(order)) {
    next[catId] = channels.map((ch) => {
      const src = incoming.get(ch.id)
      if (!src) return ch
      const pending = src.pending === undefined ? ch.pending : src.pending
      if (
        src.unread === ch.unread &&
        src.name === ch.name &&
        Boolean(pending) === Boolean(ch.pending) &&
        (src.creatorId ?? null) === (ch.creatorId ?? null) &&
        (src.type ?? null) === (ch.type ?? null)
      ) return ch
      changed = true
      return {
        ...ch,
        unread: src.unread,
        name: src.name,
        pending,
        creatorId: src.creatorId,
        type: src.type,
      }
    })
  }
  return { next: changed ? next : order, changed }
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
  const [collapsed, setCollapsed] = useAtom(useCreateAtom<Set<string>>(new Set<string>()));
  const layout = useCreateAtom<{ identity: string; categories: string[]; channels: Record<string, string[]> } | null>(null);
  const [preview, setPreview] = useAtom(layout);
  const identity = JSON.stringify(categories.map((category) => [category.id, category.channels.map((channel) => channel.id)]));
  const channelFacts = JSON.stringify(categories.flatMap((category) => category.channels));
  const canonicalChannels = useMemo(() => new Map((JSON.parse(channelFacts) as Channel[]).map((channel) => [channel.id, channel])), [channelFacts]);
  const baseOrder = useMemo(() => Object.fromEntries(JSON.parse(identity) as Array<[string, string[]]>), [identity]);
  const current = useMemo(() => preview?.identity === identity ? preview : { identity, categories: Object.keys(baseOrder), channels: baseOrder }, [preview, identity, baseOrder]);
  const catOrder = current.categories;
  const order = useMemo<ChannelOrder>(() => Object.fromEntries(Object.entries(current.channels).map(([id, ids]) => [id, ids.flatMap((channelId) => {
    const channel = canonicalChannels.get(channelId);
    return channel ? [channel] : [];
  })])), [current.channels, canonicalChannels]);
  const catNames = Object.fromEntries(categories.map((category) => [category.id, category.name]));
  const catPrivate = Object.fromEntries(categories.map((category) => [category.id, !!category.private]));
  const catPending = Object.fromEntries(categories.map((category) => [category.id, !!category.pending]));
  const catCreators = Object.fromEntries(categories.map((category) => [category.id, category.creatorId ?? null]));
  const toggleCat = useCallback((id: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), [setCollapsed]);
  const projectOrder = (next: ChannelOrder) => Object.fromEntries(Object.entries(next).map(([id, channels]) => [id, channels.map((channel) => channel.id)]));
  const onDragOver = ({ active, over }: DragEndEvent) => {
    if (!over || catOrder.includes(String(active.id))) return;
    const from = catOf(String(active.id), order), to = catOf(String(over.id), order);
    if (from && to && from !== to && catPrivate[from] !== catPrivate[to]) return;
    const next = moveChannelAcrossCategories(order, String(active.id), String(over.id));
    if (next !== order) setPreview({ ...current, channels: projectOrder(next) });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      const activeId = String(active.id), overId = String(over.id);
      if (catOrder.includes(activeId) && catOrder.includes(overId)) setPreview({ ...current, categories: reorderCategories(catOrder, activeId, overId) });
      else if (!catOrder.includes(activeId)) setPreview({ ...current, channels: projectOrder(reorderChannelsWithin(order, activeId, overId)) });
    }
  };
  return { collapsed, catOrder, order, catNames, catPrivate, catPending, catCreators, toggleCat, onDragOver, onDragEnd };
}
export type ChannelTree = ReturnType<typeof useChannelTree>
