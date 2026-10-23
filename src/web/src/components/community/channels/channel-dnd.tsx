"use client"

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useDrag, useDrop } from "react-dnd"
import { useDndCancellation } from "../community-dnd"
import { catOf, type ChannelTree, type ChannelTreeDrop } from "./use-channel-tree"

const CHANNEL_ITEM = "community/channel-tree"
type Kind = "category" | "channel"
type Item = { id: string; kind: Kind; owner: object }
type Drop = { id: string }
type Controller = {
  owner: object
  active: Item | null
  canDrop: (item: Item, target: string, kind: Kind) => boolean
  begin: (id: string, kind: Kind) => Item
  finish: (item?: Item, result?: Drop | null) => void
  suppressClick: () => boolean
  lineSide: (item: Item | null, id: string, kind: Kind) => "top" | "bottom"
}
const ChannelDndContext = createContext<Controller | null>(null)

export function ChannelDndScope({ tree, onDrop, children }: {
  tree: ChannelTree
  onDrop: (event: ChannelTreeDrop) => void
  children: ReactNode
}) {
  const latest = useRef({ tree, onDrop })
  useLayoutEffect(() => { latest.current = { tree, onDrop } })
  const owner = useMemo(() => ({}), [])
  const [active, setActive] = useAtom(useCreateAtom<Item | null>(null))
  const current = useRef<Item | null>(null)
  const suppressUntil = useRef(0)
  const finish = useCallback((item?: Item, result?: Drop | null) => {
    if (!current.current) return
    current.current = null
    setActive(null)
    suppressUntil.current = Date.now() + 350
    if (item && result) latest.current.onDrop({ active: { id: item.id }, over: { id: result.id } })
  }, [setActive])
  const cancel = useCallback(() => finish(), [finish])
  useDndCancellation(cancel)
  useLayoutEffect(() => () => { current.current = null }, [])
  const controller = useMemo<Controller>(() => ({
    owner, active, finish,
    begin: (id, kind) => {
      const item = { id, kind, owner }
      current.current = item
      setActive(item)
      return item
    },
    canDrop: (item, target, kind) => {
      if (item.owner !== owner || item.id === target) return false
      const { order, catPrivate, catPending } = latest.current.tree
      if (item.kind === "category") return kind === "category" && !catPending[target]
      const from = catOf(item.id, order), to = catOf(target, order)
      return !!from && !!to && !catPending[to] && !!catPrivate[from] === !!catPrivate[to]
    },
    suppressClick: () => !!current.current || Date.now() < suppressUntil.current,
    lineSide: (item, id, kind) => {
      const { catOrder, order } = latest.current.tree
      if (!item) return "top"
      const ids = kind === "category" ? catOrder : (order[catOf(id, order) ?? ""] ?? []).map((channel) => channel.id)
      return ids.indexOf(item.id) !== -1 && ids.indexOf(item.id) < ids.indexOf(id) ? "bottom" : "top"
    },
  }), [owner, active, finish, setActive])
  return <ChannelDndContext.Provider value={controller}>{children}</ChannelDndContext.Provider>
}

export function useChannelDragActive() {
  return useContext(ChannelDndContext)?.active ?? null
}

export function useChannelDndItem(id: string, kind: Kind, canReorder: boolean) {
  const controller = useContext(ChannelDndContext)
  const [{ isDragging }, drag, preview] = useDrag<Item, Drop, { isDragging: boolean }>(() => ({
    type: CHANNEL_ITEM,
    canDrag: () => canReorder && !!controller,
    item: () => controller?.begin(id, kind) ?? null,
    end: (item, monitor) => controller?.finish(item, monitor.didDrop() ? monitor.getDropResult() : null),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  }), [controller, id, kind, canReorder])
  const [{ isOver }, drop] = useDrop<Item, Drop, { isOver: boolean }>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item) => canReorder && !!controller?.canDrop(item, id, kind),
    drop: (_item, monitor) => monitor.didDrop() ? undefined : { id },
    collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) && monitor.canDrop() }),
  }), [controller, id, kind, canReorder])
  const setNodeRef = useCallback((node: HTMLElement | null) => {
    drop(node)
    preview(node)
    if (kind === "channel") drag(canReorder ? node : null)
  }, [drop, preview, drag, kind, canReorder])
  const setActivatorNodeRef = useCallback((node: HTMLElement | null) => { drag(canReorder ? node : null) }, [drag, canReorder])
  return {
    setNodeRef, setActivatorNodeRef, isDragging, isOver,
    dragActive: controller?.active ?? null,
    suppressClick: () => controller?.suppressClick() ?? false,
    lineSide: controller?.lineSide(controller.active, id, kind) ?? "top",
  }
}

export function ChannelDropContainer({ id, children, className }: { id: string; children: ReactNode; className: string }) {
  const controller = useContext(ChannelDndContext)
  const [, drop] = useDrop<Item, Drop>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item) => item.kind === "channel" && !!controller?.canDrop(item, id, "category"),
    drop: (_item, monitor) => monitor.didDrop() ? undefined : { id },
  }), [controller, id])
  return <div ref={(node) => { drop(node) }} className={className}>{children}</div>
}
