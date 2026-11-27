"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
  type ReactNode,
  type SyntheticEvent,
} from "react"
import { useDrag, useDragDropManager, useDragLayer, useDrop, type DropTargetMonitor } from "react-dnd"
import { getEmptyImage } from "react-dnd-html5-backend"
import { createStore, useAtom, useCreateAtom, useSelector, type Store } from "@tanstack/react-store"
import { useDndCancellation } from "../community-dnd"
import { ChannelDragPreview, type ChannelPreviewItem } from "./channel-drag-preview"
import { projectChannelTreeDrop, resolveChannelTreeDrop, type ChannelTree, type ChannelTreeDrop, type ChannelTreeEntity } from "./use-channel-tree"

const CHANNEL_ITEM = "community/channel-tree"
type Item = ChannelPreviewItem & { owner: object; element: HTMLElement | null }
type ReturnPreview = { item: Item; element: HTMLElement; offset: { x: number; y: number } }
type TargetId = ReturnType<DropTargetMonitor["getHandlerId"]>
type Target = {
  kind: "row" | "header" | "end"
  ownerId: string
  ownerKind: ChannelTreeEntity["kind"]
  instruction: (item: Item, point: { x: number; y: number } | null) => ChannelTreeDrop | null
}
type Feedback = {
  targetId: NonNullable<TargetId>
  kind: Target["kind"]
  ownerId: string
  ownerKind: ChannelTreeEntity["kind"]
  drop: ChannelTreeDrop
  hovered: boolean
}
type ChannelDndSnapshot = {
  dragActive: Item | null
  feedback: Feedback | null
}
type Controller = {
  owner: object
  targets: Map<NonNullable<TargetId>, Target>
  rowElements: Map<string, HTMLElement>
  store: Store<ChannelDndSnapshot>
  begin: (entity: ChannelTreeEntity, element: HTMLElement | null) => Item
  finish: (item?: Item, result?: ChannelTreeDrop | null, animate?: boolean) => void
  resolve: (item: Item, result: ChannelTreeDrop) => ChannelTreeDrop | null
  suppressClick: () => boolean
  resumeClick: () => void
}

const EMPTY_DND_STORE = createStore<ChannelDndSnapshot>({ dragActive: null, feedback: null })
const ChannelDndContext = createContext<Controller | null>(null)

function sameFeedback(a: Feedback | null, b: Feedback | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.targetId === b.targetId
    && a.kind === b.kind
    && a.hovered === b.hovered
    && a.drop.placement === b.drop.placement
    && a.drop.active.id === b.drop.active.id
    && a.drop.active.kind === b.drop.active.kind
    && a.drop.over.id === b.drop.over.id
    && a.drop.over.kind === b.drop.over.kind
  )
}

function ChannelDragPreviewBridge({
  owner,
  tree,
  returning,
}: {
  owner: object
  tree: ChannelTree
  returning: ReturnType<typeof useCreateAtom<ReturnPreview | null>>
}) {
  const [returnPreview] = useAtom(returning)
  const drag = useDragLayer((monitor) => {
    const item = monitor.getItem<Item>()
    return monitor.isDragging() && monitor.getItemType() === CHANNEL_ITEM && item?.owner === owner
      ? { item, offset: monitor.getSourceClientOffset() }
      : { item: null, offset: null }
  })
  return (
    <ChannelDragPreview
      item={returnPreview?.item ?? drag.item}
      offset={returnPreview?.offset ?? drag.offset}
      tree={tree}
      returning={returnPreview}
      onReturnComplete={() => { if (returning.get() === returnPreview) returning.set(() => null) }}
    />
  )
}

export function ChannelDndScope({ tree, onDrop, enabled = true, children }: {
  tree: ChannelTree
  onDrop: (event: ChannelTreeDrop) => void
  enabled?: boolean
  children: ReactNode
}) {
  const latest = useRef({ tree, onDrop, enabled })
  useLayoutEffect(() => { latest.current = { tree, onDrop, enabled } }, [tree, onDrop, enabled])
  const manager = useDragDropManager()
  const owner = useMemo(() => ({}), [])
  const targets = useMemo(() => new Map<NonNullable<TargetId>, Target>(), [])
  const rowElements = useMemo(() => new Map<string, HTMLElement>(), [])
  const store = useMemo(() => createStore<ChannelDndSnapshot>({ dragActive: null, feedback: null }), [])
  const current = useRef<Item | null>(null)
  const lastOffset = useRef<{ x: number; y: number } | null>(null)
  const returning = useCreateAtom<ReturnPreview | null>(null)
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
  useLayoutEffect(() => {
    const monitor = manager.getMonitor()
    const syncSnapshot = () => {
      const item = monitor.getItem() as Item | null
      const active = monitor.isDragging() && monitor.getItemType() === CHANNEL_ITEM && item?.owner === owner
      const dragActive = active ? item : null
      if (active) {
        const offset = monitor.getSourceClientOffset()
        if (offset) lastOffset.current = offset
      }
      let nextFeedback: Feedback | null = null
      if (active && latest.current.enabled && item) {
        const point = monitor.getClientOffset()
        for (const targetId of monitor.getTargetIds().toReversed()) {
          const target = targets.get(targetId)
          if (!target || !monitor.canDropOnTarget(targetId)) continue
          const drop = target.instruction(item, point)
          if (drop) { nextFeedback = { targetId, kind: target.kind, ownerId: target.ownerId, ownerKind: target.ownerKind, drop, hovered: true }; break }
        }
        if (!nextFeedback) {
          for (const [targetId, target] of targets) {
            if (target.kind !== "end") continue
            const drop = target.instruction(item, point)
            if (drop) { nextFeedback = { targetId, kind: target.kind, ownerId: target.ownerId, ownerKind: target.ownerKind, drop, hovered: false }; break }
          }
        }
      }
      const prev = store.get()
      if (prev.dragActive !== dragActive || !sameFeedback(prev.feedback, nextFeedback)) {
        store.setState(() => ({ dragActive, feedback: nextFeedback }))
      }
    }
    syncSnapshot()
    const unsubState = monitor.subscribeToStateChange(syncSnapshot)
    const unsubOffset = monitor.subscribeToOffsetChange(syncSnapshot)
    return () => {
      unsubState()
      unsubOffset()
    }
  }, [manager, owner, store, targets])
  useLayoutEffect(() => () => {
    current.current = null
    returning.set(() => null)
    store.setState(() => ({ dragActive: null, feedback: null }))
    if ((manager.getMonitor().getItem() as Item | null)?.owner === owner && manager.getMonitor().isDragging()) manager.getActions().endDrag()
  }, [manager, owner, returning, store])
  const controller = useMemo<Controller>(() => ({
    owner, targets, rowElements, store, finish,
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
  }), [owner, targets, rowElements, store, finish, returning])
  return (
    <ChannelDndContext.Provider value={controller}>
      {children}
      <ChannelDragPreviewBridge owner={owner} tree={tree} returning={returning} />
    </ChannelDndContext.Provider>
  )
}

export function useChannelDragActive() {
  const controller = useContext(ChannelDndContext)
  return useSelector(controller?.store ?? EMPTY_DND_STORE, (state) => state.dragActive)
}

export type ChannelDndBindingHandle = {
  onNode: (node: HTMLElement | null) => void
  onHeader: (node: HTMLElement | null) => void
}

function useChannelDndBindingEffects({
  id,
  kind,
  canReorder,
  elementRef,
  headerRef,
  pressAllowsDragRef,
  bindingRef,
}: {
  id: string
  kind: ChannelTreeEntity["kind"]
  canReorder: boolean
  elementRef: RefObject<HTMLElement | null>
  headerRef: RefObject<HTMLElement | null>
  pressAllowsDragRef: RefObject<boolean>
  bindingRef: RefObject<ChannelDndBindingHandle | null>
}) {
  const controller = useContext(ChannelDndContext)
  const instruction = useCallback((item: Item, point: { x: number; y: number } | null, append = false): ChannelTreeDrop | null => {
    if (!controller || !canReorder || !point) return null
    const rect = (append ? headerRef.current : elementRef.current)?.getBoundingClientRect()
    if (!rect) return null
    const result: ChannelTreeDrop = { active: { id: item.id, kind: item.kind }, over: { id, kind },
      placement: append ? "append" : point.y < rect.top + rect.height / 2 ? "before" : "after" }
    return controller.resolve(item, result)
  }, [canReorder, controller, elementRef, headerRef, id, kind])
  const [, drag, preview] = useDrag<Item, ChannelTreeDrop, Record<string, never>>(() => ({
    type: CHANNEL_ITEM,
    canDrag: () => canReorder && !!controller && pressAllowsDragRef.current,
    item: () => controller?.begin({ id, kind }, kind === "category" ? headerRef.current : elementRef.current) ?? null,
    end: (item, monitor) => controller?.finish(item, monitor.didDrop() ? monitor.getDropResult() : null),
  }), [canReorder, controller, elementRef, headerRef, id, kind, pressAllowsDragRef])
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
    const onNode = (node: HTMLElement | null) => {
      drop(node)
      if (kind === "channel") drag(canReorder ? node : null)
    }
    const onHeader = (node: HTMLElement | null) => {
      headerDrop(node)
      if (kind === "category") drag(canReorder ? node : null)
    }
    bindingRef.current = { onNode, onHeader }
    if (elementRef.current) onNode(elementRef.current)
    if (headerRef.current) onHeader(headerRef.current)
    if (controller) {
      if (rowTargetId !== null) controller.targets.set(rowTargetId, { kind: "row", ownerId: id, ownerKind: kind, instruction })
      if (headerTargetId !== null) controller.targets.set(headerTargetId, { kind: "header", ownerId: id, ownerKind: kind, instruction: (item, point) => instruction(item, point, true) })
    }
    return () => {
      if (bindingRef.current?.onNode === onNode) bindingRef.current = null
      drop(null)
      headerDrop(null)
      drag(null)
      if (controller) {
        if (rowTargetId !== null) controller.targets.delete(rowTargetId)
        if (headerTargetId !== null) controller.targets.delete(headerTargetId)
      }
    }
  }, [bindingRef, canReorder, controller, drag, drop, elementRef, headerDrop, headerRef, headerTargetId, id, instruction, kind, rowTargetId])
}

export function ChannelDndBinding({
  id,
  kind,
  elementRef,
  headerRef,
  pressAllowsDragRef,
  bindingRef,
}: {
  id: string
  kind: ChannelTreeEntity["kind"]
  elementRef: RefObject<HTMLElement | null>
  headerRef: RefObject<HTMLElement | null>
  pressAllowsDragRef: RefObject<boolean>
  bindingRef: RefObject<ChannelDndBindingHandle | null>
}) {
  useChannelDndBindingEffects({
    id,
    kind,
    canReorder: true,
    elementRef,
    headerRef,
    pressAllowsDragRef,
    bindingRef,
  })
  return null
}

export function useChannelDndRow(id: string, kind: ChannelTreeEntity["kind"]) {
  const controller = useContext(ChannelDndContext)
  const store = controller?.store ?? EMPTY_DND_STORE
  const elementRef = useRef<HTMLElement | null>(null)
  const headerRef = useRef<HTMLElement | null>(null)
  const pressAllowsDragRef = useRef(true)
  const bindingRef = useRef<ChannelDndBindingHandle | null>(null)

  const isDragging = useSelector(store, (state) => state.dragActive?.id === id && state.dragActive?.kind === kind)
  const placement = useSelector(store, (state) => {
    const fb = state.feedback
    if (!fb?.hovered || fb.kind === "end") return null
    return fb.ownerId === id && fb.ownerKind === kind ? fb.drop.placement : null
  })
  const dragActive = useSelector(store, (state) => state.dragActive)

  const setNodeRef = useCallback((node: HTMLElement | null) => {
    const previous = elementRef.current
    elementRef.current = node
    if (controller && kind === "channel") {
      if (node) controller.rowElements.set(id, node)
      else if (previous && controller.rowElements.get(id) === previous) controller.rowElements.delete(id)
    }
    bindingRef.current?.onNode(node)
  }, [controller, id, kind])
  const setActivatorNodeRef = useCallback((node: HTMLElement | null) => {
    headerRef.current = node
    bindingRef.current?.onHeader(node)
  }, [])
  const suppressClick = useCallback(() => controller?.suppressClick() ?? false, [controller])
  const resumeClick = useCallback((event?: SyntheticEvent<HTMLElement>) => {
    const target = event?.target
    const action = target instanceof Element ? target.closest("button") : null
    pressAllowsDragRef.current = !action || action === event?.currentTarget || !event?.currentTarget.contains(action)
    controller?.resumeClick()
  }, [controller])

  return {
    elementRef,
    headerRef,
    pressAllowsDragRef,
    bindingRef,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
    isOver: placement !== null,
    placement,
    lineSide: placement === "after" ? "bottom" as const : "top" as const,
    dragActive,
    suppressClick,
    resumeClick,
  }
}

export function useChannelDndItem(id: string, kind: ChannelTreeEntity["kind"], canReorder: boolean) {
  const row = useChannelDndRow(id, kind)
  useChannelDndBindingEffects({
    id,
    kind,
    canReorder,
    elementRef: row.elementRef,
    headerRef: row.headerRef,
    pressAllowsDragRef: row.pressAllowsDragRef,
    bindingRef: row.bindingRef,
  })
  return row
}

export function ChannelDropContainer({ id, before = false, lastRowId }: { id: string; before?: boolean; lastRowId?: string }) {
  const controller = useContext(ChannelDndContext)
  const store = controller?.store ?? EMPTY_DND_STORE
  const anchor = useRef<HTMLDivElement | null>(null)
  const instruction = useCallback((item: Item | null, point: { x: number; y: number } | null): ChannelTreeDrop | null => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!item || item.kind !== "channel" || !point || !rect) return null
    const top = rect.top - (before ? 16 : 0)
    const lastRowEl = lastRowId ? controller?.rowElements.get(lastRowId) : undefined
    const row = lastRowEl?.getBoundingClientRect()
    const overLast = row && point.x >= row.left && point.x <= row.right && point.y >= row.top + row.height / 2 && point.y < row.bottom
    const overEnd = point.x >= rect.left && point.x <= rect.right && point.y >= top && point.y < top + 16
    if (!overLast && !overEnd) return null
    const result: ChannelTreeDrop = { active: { id: item.id, kind: item.kind }, over: { id, kind: "category" }, placement: "append" }
    return controller?.resolve(item, result) ?? null
  }, [controller, id, before, lastRowId])
  const [{ targetId }, drop] = useDrop<Item, ChannelTreeDrop, { targetId: TargetId }>(() => ({
    accept: CHANNEL_ITEM,
    canDrop: (item, monitor) => !!instruction(item, monitor.getClientOffset()),
    drop: (item, monitor) => monitor.didDrop() ? undefined : instruction(item, monitor.getClientOffset()) ?? undefined,
    collect: monitor => ({ targetId: monitor.getHandlerId() }),
  }), [instruction])
  const setDropRef = useCallback((node: HTMLDivElement | null) => { drop(node) }, [drop])
  useLayoutEffect(() => {
    if (!controller || targetId === null) return
    controller.targets.set(targetId, { kind: "end", ownerId: id, ownerKind: "category", instruction })
    return () => { controller.targets.delete(targetId) }
  }, [controller, id, targetId, instruction])
  const visible = useSelector(store, (state) => {
    const fb = state.feedback
    return Boolean(fb?.hovered && fb.kind !== "header" && fb.drop.placement === "append" && fb.drop.over.id === id)
  })
  const open = useSelector(store, (state) => {
    const fb = state.feedback
    const isVisible = Boolean(fb?.hovered && fb.kind !== "header" && fb.drop.placement === "append" && fb.drop.over.id === id)
    return isVisible || Boolean(fb?.kind === "end" && fb.targetId === targetId)
  })
  return <div ref={anchor} data-channel-drop-anchor={id} aria-hidden="true" className="relative h-0">
    <div ref={setDropRef} data-channel-drop-end={id} data-drop-visible={visible || undefined}
      className={`absolute inset-x-0 ${before ? "bottom-0" : "top-0"} ${open ? "h-4" : "pointer-events-none h-0"} ${visible ? "rounded-md border border-dashed border-primary bg-primary/5" : ""}`} />
  </div>
}
