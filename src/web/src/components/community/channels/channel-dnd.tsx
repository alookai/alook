"use client"

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type SyntheticEvent } from "react"
import { useDrag, useDragDropManager, useDragLayer, useDrop, type DropTargetMonitor } from "react-dnd"
import { getEmptyImage } from "react-dnd-html5-backend"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useDndCancellation } from "../community-dnd"
import { ChannelDragPreview, type ChannelPreviewItem } from "./channel-drag-preview"
import { projectChannelTreeDrop, resolveChannelTreeDrop, type ChannelTree, type ChannelTreeDrop, type ChannelTreeEntity } from "./use-channel-tree"

const CHANNEL_ITEM = "community/channel-tree"
type Item = ChannelPreviewItem & { owner: object; element: HTMLElement | null }
type ReturnPreview = { item: Item; element: HTMLElement; offset: { x: number; y: number } }
type TargetId = ReturnType<DropTargetMonitor["getHandlerId"]>
type Target = {
  kind: "row" | "header" | "end"
  instruction: (item: Item, point: { x: number; y: number } | null) => ChannelTreeDrop | null
}
type Feedback = { targetId: NonNullable<TargetId>; kind: Target["kind"]; drop: ChannelTreeDrop; hovered: boolean }
type Controller = {
  owner: object
  targets: Map<NonNullable<TargetId>, Target>
  begin: (entity: ChannelTreeEntity, element: HTMLElement | null) => Item
  finish: (item?: Item, result?: ChannelTreeDrop | null, animate?: boolean) => void
  resolve: (item: Item, result: ChannelTreeDrop) => ChannelTreeDrop | null
  suppressClick: () => boolean
  resumeClick: () => void
}
const ChannelDndContext = createContext<Controller | null>(null)
const ChannelFeedbackContext = createContext<Feedback | null>(null)

export function ChannelDndScope({ tree, onDrop, enabled = true, children }: {
  tree: ChannelTree
  onDrop: (event: ChannelTreeDrop) => void
  enabled?: boolean
  children: ReactNode
}) {
  const latest = useRef({ tree, onDrop, enabled })
  useLayoutEffect(() => { latest.current = { tree, onDrop, enabled } })
  const manager = useDragDropManager()
  const owner = useMemo(() => ({}), [])
  const targets = useMemo(() => new Map<NonNullable<TargetId>, Target>(), [])
  const current = useRef<Item | null>(null)
  const lastOffset = useRef<{ x: number; y: number } | null>(null)
  const returning = useCreateAtom<ReturnPreview | null>(null)
  const [returnPreview] = useAtom(returning)
  const suppressed = useRef(false)
  const finish = useCallback((item?: Item, result?: ChannelTreeDrop | null, animate = true) => {
    const origin = current.current
    if (!origin) return
    current.current = null
    suppressed.current = true
    if (item?.owner === owner && result && latest.current.enabled && projectChannelTreeDrop(latest.current.tree, result)) {
      latest.current.onDrop(result)
    } else {
      const offset = manager.getMonitor().getSourceClientOffset() ?? lastOffset.current
      const element = origin.element
      if (animate && element?.isConnected && origin.width > 0 && origin.height > 0 && offset
        && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        returning.set(() => ({ item: origin, element, offset }))
      }
    }
  }, [manager, owner, returning])
  useDndCancellation(useCallback(() => finish(), [finish]))
  useLayoutEffect(() => {
    const monitor = manager.getMonitor()
    if (!enabled) returning.set(() => null)
    if (enabled || !monitor.isDragging() || (monitor.getItem() as Item | null)?.owner !== owner) return
    finish(undefined, undefined, false)
    manager.getActions().endDrag()
  }, [enabled, finish, manager, owner, returning])
  useLayoutEffect(() => manager.getMonitor().subscribeToOffsetChange(() => {
    const monitor = manager.getMonitor()
    if ((monitor.getItem() as Item | null)?.owner !== owner) return
    const offset = monitor.getSourceClientOffset()
    if (offset) lastOffset.current = offset
  }), [manager, owner])
  useLayoutEffect(() => () => {
    current.current = null
    returning.set(() => null)
    if ((manager.getMonitor().getItem() as Item | null)?.owner === owner && manager.getMonitor().isDragging()) manager.getActions().endDrag()
  }, [manager, owner, returning])
  const controller = useMemo<Controller>(() => ({
    owner, targets, finish,
    begin: (entity, element) => {
      const rect = element?.getBoundingClientRect()
      const item = { ...entity, owner, element, width: rect?.width ?? 0, height: rect?.height ?? 0 }
      returning.set(() => null)
      lastOffset.current = null
      current.current = item
      suppressed.current = false
      return item
    },
    resolve: (item, result) => item.owner === owner && latest.current.enabled ? resolveChannelTreeDrop(latest.current.tree, result) : null,
    suppressClick: () => !!current.current || suppressed.current,
    resumeClick: () => { if (!current.current) suppressed.current = false },
  }), [owner, targets, finish, returning])
  const feedback = useDragLayer(monitor => {
    const item = monitor.getItem<Item>()
    if (!latest.current.enabled || !monitor.isDragging() || monitor.getItemType() !== CHANNEL_ITEM || item?.owner !== owner) {
      return null
    }
    const point = monitor.getClientOffset()
    let feedback: Feedback | null = null
    for (const targetId of manager.getMonitor().getTargetIds().toReversed()) {
      const target = targets.get(targetId)
      if (!target || !manager.getMonitor().canDropOnTarget(targetId)) continue
      const drop = target.instruction(item, point)
      if (drop) { feedback = { targetId, kind: target.kind, drop, hovered: true }; break }
    }
    if (!feedback) for (const [targetId, target] of targets) {
      if (target.kind !== "end") continue
      const drop = target.instruction(item, point)
      if (drop) { feedback = { targetId, kind: target.kind, drop, hovered: false }; break }
    }
    return feedback
  })
  const drag = useDragLayer(monitor => {
    const item = monitor.getItem<Item>()
    return monitor.isDragging() && monitor.getItemType() === CHANNEL_ITEM && item?.owner === owner
      ? { item, offset: monitor.getSourceClientOffset() } : { item: null, offset: null }
  })
  return <ChannelDndContext.Provider value={controller}><ChannelFeedbackContext.Provider value={feedback}>{children}
    <ChannelDragPreview item={returnPreview?.item ?? drag.item} offset={returnPreview?.offset ?? drag.offset} tree={tree}
      returning={returnPreview} onReturnComplete={() => { if (returning.get() === returnPreview) returning.set(() => null) }} />
  </ChannelFeedbackContext.Provider></ChannelDndContext.Provider>
}

export function useChannelDragActive() {
  const controller = useContext(ChannelDndContext)
  return useDragLayer((monitor) => {
    const item = monitor.getItem<Item>()
    return monitor.isDragging() && monitor.getItemType() === CHANNEL_ITEM && item?.owner === controller?.owner ? item : null
  })
}

export function useChannelDndItem(id: string, kind: ChannelTreeEntity["kind"], canReorder: boolean) {
  const controller = useContext(ChannelDndContext)
  const feedback = useContext(ChannelFeedbackContext)
  const element = useRef<HTMLElement | null>(null)
  const header = useRef<HTMLElement | null>(null)
  const pressAllowsDrag = useRef(true)
  const instruction = useCallback((item: Item, point: { x: number; y: number } | null, append = false): ChannelTreeDrop | null => {
    if (!controller || !canReorder || !point) return null
    const rect = (append ? header.current : element.current)?.getBoundingClientRect()
    if (!rect) return null
    const result: ChannelTreeDrop = { active: { id: item.id, kind: item.kind }, over: { id, kind },
      placement: append ? "append" : point.y < rect.top + rect.height / 2 ? "before" : "after" }
    return controller.resolve(item, result)
  }, [controller, canReorder, id, kind])
  const [{ isDragging }, drag, preview] = useDrag<Item, ChannelTreeDrop, { isDragging: boolean }>(() => ({
    type: CHANNEL_ITEM,
    canDrag: () => canReorder && !!controller && pressAllowsDrag.current,
    item: () => controller?.begin({ id, kind }, kind === "category" ? header.current : element.current) ?? null,
    end: (item, monitor) => controller?.finish(item, monitor.didDrop() ? monitor.getDropResult() : null),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  }), [controller, id, kind, canReorder])
  useEffect(() => {
    preview(getEmptyImage(), { captureDraggingState: true })
    return () => { preview(null) }
  }, [preview])
  const [{ rowTargetId }, drop] = useDrop<Item, ChannelTreeDrop, { rowTargetId: TargetId }>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item, monitor) => (kind === "channel" || item.kind === "category") && !!instruction(item, monitor.getClientOffset()),
    drop: (item, monitor) => monitor.didDrop() ? undefined : instruction(item, monitor.getClientOffset()) ?? undefined,
    collect: (monitor) => ({ rowTargetId: monitor.getHandlerId() }),
  }), [instruction, kind])
  const [{ headerTargetId }, headerDrop] = useDrop<Item, ChannelTreeDrop, { headerTargetId: TargetId }>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item, monitor) => kind === "category" && item.kind === "channel" && !!instruction(item, monitor.getClientOffset(), true),
    drop: (item, monitor) => monitor.didDrop() ? undefined : instruction(item, monitor.getClientOffset(), true) ?? undefined,
    collect: (monitor) => ({ headerTargetId: monitor.getHandlerId() }),
  }), [instruction, kind])
  useLayoutEffect(() => {
    if (!controller) return
    if (rowTargetId !== null) controller.targets.set(rowTargetId, { kind: "row", instruction })
    if (headerTargetId !== null) controller.targets.set(headerTargetId, { kind: "header", instruction: (item, point) => instruction(item, point, true) })
    return () => {
      if (rowTargetId !== null) controller.targets.delete(rowTargetId)
      if (headerTargetId !== null) controller.targets.delete(headerTargetId)
    }
  }, [controller, rowTargetId, headerTargetId, instruction])
  const placement = feedback?.hovered && (feedback.targetId === rowTargetId || feedback.targetId === headerTargetId) ? feedback.drop.placement : null
  const setNodeRef = useCallback((node: HTMLElement | null) => {
    element.current = node; drop(node)
    if (kind === "channel") drag(canReorder ? node : null)
  }, [drop, drag, kind, canReorder])
  const setActivatorNodeRef = useCallback((node: HTMLElement | null) => {
    header.current = node; headerDrop(node); drag(canReorder ? node : null)
  }, [drag, headerDrop, canReorder])
  return {
    setNodeRef, setActivatorNodeRef, isDragging, isOver: placement !== null,
    placement, lineSide: placement === "after" ? "bottom" as const : "top" as const,
    dragActive: useChannelDragActive(),
    suppressClick: () => controller?.suppressClick() ?? false,
    resumeClick: (event?: SyntheticEvent<HTMLElement>) => {
      const target = event?.target
      const action = target instanceof Element ? target.closest("button") : null
      pressAllowsDrag.current = !action || action === event?.currentTarget || !event?.currentTarget.contains(action)
      controller?.resumeClick()
    },
  }
}

export function ChannelDropContainer({ id, before = false, lastRowId }: { id: string; before?: boolean; lastRowId?: string }) {
  const controller = useContext(ChannelDndContext)
  const feedback = useContext(ChannelFeedbackContext)
  const anchor = useRef<HTMLDivElement | null>(null)
  const lastRow = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    lastRow.current = Array.from(anchor.current?.parentElement?.querySelectorAll<HTMLElement>("[data-channel-tree-row]") ?? []).find((node) => node.dataset.channelTreeRow === lastRowId) ?? null
  })
  const instruction = useCallback((item: Item | null, point: { x: number; y: number } | null): ChannelTreeDrop | null => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!item || item.kind !== "channel" || !point || !rect) return null
    const top = rect.top - (before ? 16 : 0)
    const row = lastRow.current?.getBoundingClientRect()
    const overLast = row && point.x >= row.left && point.x <= row.right && point.y >= row.top + row.height / 2 && point.y < row.bottom
    const overEnd = point.x >= rect.left && point.x <= rect.right && point.y >= top && point.y < top + 16
    if (!overLast && !overEnd) return null
    const result: ChannelTreeDrop = { active: { id: item.id, kind: item.kind }, over: { id, kind: "category" }, placement: "append" }
    return controller?.resolve(item, result) ?? null
  }, [controller, id, before])
  const [{ targetId }, drop] = useDrop<Item, ChannelTreeDrop, { targetId: TargetId }>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item, monitor) => !!instruction(item, monitor.getClientOffset()),
    drop: (item, monitor) => monitor.didDrop() ? undefined : instruction(item, monitor.getClientOffset()) ?? undefined,
    collect: monitor => ({ targetId: monitor.getHandlerId() }),
  }), [instruction])
  const setDropRef = useCallback((node: HTMLDivElement | null) => { drop(node) }, [drop])
  useLayoutEffect(() => {
    if (!controller || targetId === null) return
    controller.targets.set(targetId, { kind: "end", instruction })
    return () => { controller.targets.delete(targetId) }
  }, [controller, targetId, instruction])
  const visible = feedback?.hovered && feedback.kind !== "header" && feedback.drop.placement === "append" && feedback.drop.over.id === id
  const open = visible || feedback?.kind === "end" && feedback.targetId === targetId
  return <div ref={anchor} data-channel-drop-anchor={id} aria-hidden="true" className="relative h-0">
    <div ref={setDropRef} data-channel-drop-end={id} data-drop-visible={visible || undefined}
      className={`absolute inset-x-0 ${before ? "bottom-0" : "top-0"} ${open ? "h-4" : "pointer-events-none h-0"} ${visible ? "rounded-md border border-dashed border-primary bg-primary/5" : ""}`} />
  </div>
}
