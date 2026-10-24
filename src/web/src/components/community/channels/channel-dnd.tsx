"use client"

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react"
import { useDrag, useDragDropManager, useDragLayer, useDrop, type DropTargetMonitor } from "react-dnd"
import { useDndCancellation } from "../community-dnd"
import { projectChannelTreeDrop, resolveChannelTreeDrop, type ChannelTree, type ChannelTreeDrop, type ChannelTreeEntity } from "./use-channel-tree"

const CHANNEL_ITEM = "community/channel-tree"
type Item = ChannelTreeEntity & { owner: object }
type TargetId = ReturnType<DropTargetMonitor["getHandlerId"]>
type Controller = {
  owner: object
  begin: (entity: ChannelTreeEntity) => Item
  finish: (item?: Item, result?: ChannelTreeDrop | null) => void
  resolve: (item: Item, result: ChannelTreeDrop) => ChannelTreeDrop | null
  suppressClick: () => boolean
  resumeClick: () => void
}
const ChannelDndContext = createContext<Controller | null>(null)

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
  const current = useRef<Item | null>(null)
  const suppressed = useRef(false)
  const finish = useCallback((item?: Item, result?: ChannelTreeDrop | null) => {
    if (!current.current) return
    current.current = null
    suppressed.current = true
    if (item?.owner === owner && result && latest.current.enabled && projectChannelTreeDrop(latest.current.tree, result)) latest.current.onDrop(result)
  }, [owner])
  useDndCancellation(useCallback(() => finish(), [finish]))
  useLayoutEffect(() => {
    const monitor = manager.getMonitor()
    if (enabled || !monitor.isDragging() || (monitor.getItem() as Item | null)?.owner !== owner) return
    finish()
    manager.getActions().endDrag()
  }, [enabled, finish, manager, owner])
  useLayoutEffect(() => () => {
    current.current = null
    if ((manager.getMonitor().getItem() as Item | null)?.owner === owner && manager.getMonitor().isDragging()) manager.getActions().endDrag()
  }, [manager, owner])
  const controller = useMemo<Controller>(() => ({
    owner, finish,
    begin: (entity) => { const item = { ...entity, owner }; current.current = item; suppressed.current = false; return item },
    resolve: (item, result) => item.owner === owner && latest.current.enabled ? resolveChannelTreeDrop(latest.current.tree, result) : null,
    suppressClick: () => !!current.current || suppressed.current,
    resumeClick: () => { if (!current.current) suppressed.current = false },
  }), [owner, finish])
  return <ChannelDndContext.Provider value={controller}>{children}</ChannelDndContext.Provider>
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
  const nativeMonitor = useDragDropManager().getMonitor()
  const element = useRef<HTMLElement | null>(null)
  const header = useRef<HTMLElement | null>(null)
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
    canDrag: () => canReorder && !!controller,
    item: () => controller?.begin({ id, kind }) ?? null,
    end: (item, monitor) => controller?.finish(item, monitor.didDrop() ? monitor.getDropResult() : null),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  }), [controller, id, kind, canReorder])
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
  const latestTargets = useRef({ rowTargetId, headerTargetId, instruction, kind })
  useLayoutEffect(() => { latestTargets.current = { rowTargetId, headerTargetId, instruction, kind } })
  const feedback = useDragLayer((monitor) => {
    const item = monitor.getItem<Item>()
    const current = latestTargets.current
    const headerOver = current.headerTargetId !== null && nativeMonitor.isOverTarget(current.headerTargetId, { shallow: true }) && nativeMonitor.canDropOnTarget(current.headerTargetId)
    const rowOver = current.rowTargetId !== null && nativeMonitor.isOverTarget(current.rowTargetId, { shallow: current.kind !== "category" }) && nativeMonitor.canDropOnTarget(current.rowTargetId)
    return item && (rowOver || headerOver) ? current.instruction(item, monitor.getClientOffset(), headerOver)?.placement ?? null : null
  })
  const setNodeRef = useCallback((node: HTMLElement | null) => {
    element.current = node; drop(node); preview(node)
    if (kind === "channel") drag(canReorder ? node : null)
  }, [drop, preview, drag, kind, canReorder])
  const setActivatorNodeRef = useCallback((node: HTMLElement | null) => {
    header.current = node; headerDrop(node); drag(canReorder ? node : null)
  }, [drag, headerDrop, canReorder])
  return {
    setNodeRef, setActivatorNodeRef, isDragging, isOver: feedback !== null,
    placement: feedback, lineSide: feedback === "after" ? "bottom" as const : "top" as const,
    dragActive: useChannelDragActive(),
    suppressClick: () => controller?.suppressClick() ?? false,
    resumeClick: () => controller?.resumeClick(),
  }
}

export function ChannelDropContainer({ id, before = false, lastRowId }: { id: string; before?: boolean; lastRowId?: string }) {
  const controller = useContext(ChannelDndContext)
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
  const [, drop] = useDrop<Item, ChannelTreeDrop>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item, monitor) => !!instruction(item, monitor.getClientOffset()),
    drop: (item, monitor) => monitor.didDrop() ? undefined : instruction(item, monitor.getClientOffset()) ?? undefined,
  }), [instruction])
  const setDropRef = useCallback((node: HTMLDivElement | null) => { drop(node) }, [drop])
  const latestInstruction = useRef(instruction)
  useLayoutEffect(() => { latestInstruction.current = instruction })
  const visible = useDragLayer((monitor) => !!latestInstruction.current(monitor.getItem<Item>(), monitor.getClientOffset()))
  return <div ref={anchor} data-channel-drop-anchor={id} aria-hidden="true" className="relative h-0">
    <div ref={setDropRef} data-channel-drop-end={id} data-drop-visible={visible || undefined}
      className={`absolute inset-x-0 ${before ? "bottom-0" : "top-0"} ${visible ? "h-4 rounded-md border border-dashed border-primary bg-primary/5" : "pointer-events-none h-0"}`} />
  </div>
}
