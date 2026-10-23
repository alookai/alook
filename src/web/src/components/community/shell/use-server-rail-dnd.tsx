"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react"
import { useDrag, useDragLayer, useDragDropManager, useDrop } from "react-dnd"
import { getEmptyImage } from "react-dnd-html5-backend"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useDndCancellation } from "../community-dnd"
import { railTopLevel, railOperationAvailability, railInstructionIsAvailable, type RailContainer, type RailEntity, type RailInstruction, type RailState } from "@/lib/community/server-rail-model"

const RAIL_ITEM = "community/server-rail"
type RailDrag = { entity: RailEntity; owner: object }
type RailDrop = { instruction: RailInstruction } | { cancelled: true }
export type RailReturn = { entity: RailEntity; offset: { x: number; y: number }; element: HTMLElement }
type Options = {
  getState: () => RailState
  canStart: () => boolean
  onDragStart: (source: RailEntity) => void
  onPreview: (instruction: RailInstruction | null) => void
  onDrop: (instruction: RailInstruction) => void
  onCancel: () => void
}

export function railInstructionAt(state: RailState, source: RailEntity, target: RailEntity, ratio: number): RailInstruction | null {
  const available = railOperationAvailability(state, source, target)
  const folderId = target.kind === "server" ? state.folderIds.find((id) => state.folders[id]?.includes(target.id)) : undefined
  const operation = source.kind === "server" && target.kind === "folder" ? "combine"
    : folderId ? ratio < 0.5 ? "reorder-before" : "reorder-after"
    : ratio < 0.25 ? "reorder-before" : ratio > 0.75 ? "reorder-after"
    : source.kind === "server" ? "combine" : ratio < 0.5 ? "reorder-before" : "reorder-after"
  if (operation === "reorder-after") {
    const last = folderId ? state.folders[folderId]?.at(-1) === target.id : railTopLevel(state).at(-1)?.id === target.id
    if (last) {
      const append: RailInstruction = { operation: "append", source, target: folderId ? { kind: "folder-content", id: folderId } : { kind: "root", id: "root" } }
      return railInstructionIsAvailable(state, append) ? append : null
    }
  }
  return available[operation] ? { source, target, operation } : null
}

export function useServerRailDnd(options: Options) {
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  const owner = useMemo(() => ({}), [])
  const manager = useDragDropManager()
  const returning = useCreateAtom<RailReturn | null>(null)
  const source = useRef<{ entity: RailEntity; element: HTMLElement | null } | null>(null)
  const lastOffset = useRef<{ x: number; y: number } | null>(null)
  const active = useRef(false)
  const preview = useRef<RailInstruction | null>(null)
  const suppressNextClick = useRef(false)
  const updatePreview = useCallback((next: RailInstruction | null) => {
    if (next && !active.current) return
    const previous = preview.current
    if (previous?.operation === next?.operation && previous?.target.kind === next?.target.kind && previous?.target.id === next?.target.id) return
    preview.current = next
    latest.current.onPreview(next)
  }, [])
  const finish = useCallback((result?: RailDrop | null, animate = true) => {
    if (!active.current) return
    active.current = false
    suppressNextClick.current = true
    updatePreview(null)
    if (result && "instruction" in result) latest.current.onDrop(result.instruction)
    else {
      const offset = manager.getMonitor().getSourceClientOffset() ?? lastOffset.current
      const origin = source.current
      if (animate && origin?.element?.isConnected && offset && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const value: RailReturn = { entity: origin.entity, element: origin.element, offset }
        returning.set(() => value)
      }
      latest.current.onCancel()
    }
    source.current = null
  }, [manager, returning, updatePreview])
  const cancel = useCallback(() => finish(), [finish])
  useDndCancellation(cancel)
  const [{ background }, cancelDrop] = useDrop<RailDrag, RailDrop, { background: boolean }>(() => ({
    accept: RAIL_ITEM,
    canDrop: (item) => item.owner === owner && active.current,
    drop: (_item, monitor) => monitor.didDrop() ? undefined : { cancelled: true },
    collect: (monitor) => ({ background: monitor.isOver({ shallow: true }) }),
  }), [owner])
  useLayoutEffect(() => { if (background) updatePreview(null) }, [background, updatePreview])
  useEffect(() => {
    cancelDrop(document.body)
    return () => { cancelDrop(null) }
  }, [cancelDrop])
  useLayoutEffect(() => manager.getMonitor().subscribeToStateChange(() => {
    if (active.current && manager.getMonitor().getTargetIds().length === 0) updatePreview(null)
  }), [manager, updatePreview])
  useLayoutEffect(() => manager.getMonitor().subscribeToOffsetChange(() => {
    const offset = manager.getMonitor().getSourceClientOffset()
    if (active.current && offset) lastOffset.current = offset
  }), [manager])
  useLayoutEffect(() => () => { finish(null, false); returning.set(() => null) }, [finish, returning])
  return useMemo(() => ({
    owner, latest, updatePreview, finish, returning,
    completeReturn: (value: RailReturn) => { if (returning.get() === value) returning.set(() => null) },
    begin: (entity: RailEntity, element: HTMLElement | null = null): RailDrag | null => {
      if (!latest.current.canStart()) return null
      returning.set(() => null)
      lastOffset.current = null
      source.current = { entity, element }
      active.current = true
      latest.current.onDragStart(entity)
      return { entity, owner }
    },
    suppressClick: () => active.current || suppressNextClick.current,
    resumeClick: () => { if (!active.current) suppressNextClick.current = false },
    cancel: () => {
      returning.set(() => null)
      if (!active.current) return
      finish(null, false)
      if (manager.getMonitor().isDragging()) manager.getActions().endDrag()
    },
  }), [owner, updatePreview, finish, manager, returning])
}
export type RailDndController = ReturnType<typeof useServerRailDnd>

export function useServerRailDrag(dnd: RailDndController) {
  const [returning] = useAtom(dnd.returning)
  const drag = useDragLayer((monitor) => {
    const item = monitor.isDragging() && monitor.getItemType() === RAIL_ITEM ? monitor.getItem<RailDrag>() : null
    return { entity: item?.owner === dnd.owner ? item.entity : null, offset: monitor.getSourceClientOffset() }
  })
  return returning ? { entity: returning.entity, offset: returning.offset, returning } : { ...drag, returning: null }
}

export function RailDndBinding({ dnd, entity, element, handle }: {
  dnd: RailDndController
  entity: RailEntity
  element: RefObject<HTMLElement | null>
  handle: RefObject<HTMLElement | null>
}) {
  const { kind, id } = entity
  const manager = useDragDropManager()
  const [, drag, preview] = useDrag<RailDrag, RailDrop>(() => ({
    type: RAIL_ITEM,
    canDrag: () => dnd.latest.current.canStart(),
    item: () => dnd.begin(entity, handle.current),
    end: (_item, monitor) => dnd.finish(monitor.didDrop() ? monitor.getDropResult() : null),
  }), [dnd, entity.kind, entity.id])
  const instruction = useCallback((item: RailDrag, y: number | undefined) => {
    if (item.owner !== dnd.owner || y === undefined || !element.current) return null
    const rect = element.current.getBoundingClientRect()
    return railInstructionAt(dnd.latest.current.getState(), item.entity, { kind, id }, (y - rect.top) / rect.height)
  }, [dnd, element, kind, id])
  const [{ over, handlerId }, drop] = useDrop<RailDrag, RailDrop, { over: boolean; handlerId: string | symbol | null }>(() => ({
    accept: RAIL_ITEM,
    canDrop: (item, monitor) => !!instruction(item, monitor.getClientOffset()?.y),
    drop: (item, monitor) => {
      if (monitor.didDrop()) return
      const next = instruction(item, monitor.getClientOffset()?.y)
      return next ? { instruction: next } : undefined
    },
    collect: (monitor) => {
      const over = monitor.isOver({ shallow: true })
      return { over, handlerId: monitor.getHandlerId() }
    },
  }), [instruction])
  useLayoutEffect(() => {
    const monitor = manager.getMonitor()
    if (over && monitor.getTargetIds().at(-1) === handlerId) dnd.updatePreview(instruction(monitor.getItem(), monitor.getClientOffset()?.y))
  }, [dnd, manager, over, handlerId, instruction])
  useLayoutEffect(() => manager.getMonitor().subscribeToOffsetChange(() => {
    const monitor = manager.getMonitor()
    if (monitor.getTargetIds().at(-1) !== handlerId) return
    const item = monitor.getItem() as RailDrag | null
    if (item) dnd.updatePreview(instruction(item, monitor.getClientOffset()?.y))
  }), [manager, handlerId, dnd, instruction])
  useEffect(() => {
    drag(handle)
    preview(getEmptyImage(), { captureDraggingState: true })
    drop(element)
    const node = handle.current
    const suppress = (event: Event) => {
      if (dnd.suppressClick()) { event.preventDefault(); event.stopPropagation() }
    }
    const resume = () => dnd.resumeClick()
    node?.addEventListener("pointerdown", resume, true)
    node?.addEventListener("click", suppress, true)
    node?.addEventListener("contextmenu", suppress, true)
    return () => {
      drag(null); preview(null); drop(null)
      node?.removeEventListener("pointerdown", resume, true)
      node?.removeEventListener("click", suppress, true)
      node?.removeEventListener("contextmenu", suppress, true)
    }
  }, [drag, preview, drop, dnd, element, handle])
  return null
}

export function RailEndDropTarget({ dnd, target, testId, active = false }: { dnd: RailDndController; target: RailContainer; testId: string; active?: boolean }) {
  const item = useDragLayer((monitor) => monitor.isDragging() && monitor.getItemType() === RAIL_ITEM ? monitor.getItem<RailDrag>() : null)
  const { kind, id } = target
  const instruction = useCallback((drag: RailDrag): RailInstruction => ({ operation: "append", source: drag.entity, target: kind === "root" ? { kind, id: "root" } : { kind, id } }), [kind, id])
  const valid = !!item && item.owner === dnd.owner && railInstructionIsAvailable(dnd.latest.current.getState(), instruction(item))
  const [{ over }, drop] = useDrop<RailDrag, RailDrop, { over: boolean }>(() => ({
    accept: RAIL_ITEM,
    canDrop: (drag) => drag.owner === dnd.owner && railInstructionIsAvailable(dnd.latest.current.getState(), instruction(drag)),
    drop: (drag, monitor) => monitor.didDrop() ? undefined : { instruction: instruction(drag) },
    collect: (monitor) => ({ over: monitor.isOver({ shallow: true }) && monitor.canDrop() }),
  }), [dnd, instruction])
  useLayoutEffect(() => { if (over && item) dnd.updatePreview(instruction(item)) }, [dnd, over, item, instruction])
  return <div ref={(node) => { drop(node) }} data-testid={testId} aria-hidden="true"
    className={`relative z-20 -mt-2 w-full shrink-0 ${valid && (over || active) ? "h-10" : "h-0"}`}>
    {valid && <span className={`absolute left-1/2 h-2 w-12 -translate-x-1/2 ${kind === "root" ? "-top-1" : "-top-2"}`} />}
    {valid && (over || active) && <span data-slot="community-server-rail-end-region" className="pointer-events-none absolute inset-x-1 inset-y-0 rounded-[12px] border-2 border-dashed border-primary bg-primary/5" />}
  </div>
}

export function RailFolderGapDropTarget({ dnd, folderId, operation, testId }: { dnd: RailDndController; folderId: string; operation: "reorder-before" | "reorder-after"; testId: string }) {
  const instruction = useCallback((drag: RailDrag): RailInstruction => ({ operation, source: drag.entity, target: { kind: "folder", id: folderId } }), [folderId, operation])
  const [{ over, item }, drop] = useDrop<RailDrag, RailDrop, { over: boolean; item: RailDrag | null }>(() => ({
    accept: RAIL_ITEM,
    canDrop: (drag) => drag.owner === dnd.owner && railInstructionIsAvailable(dnd.latest.current.getState(), instruction(drag)),
    drop: (drag, monitor) => monitor.didDrop() ? undefined : { instruction: instruction(drag) },
    collect: (monitor) => ({ over: monitor.isOver({ shallow: true }) && monitor.canDrop(), item: monitor.getItem() }),
  }), [dnd, instruction])
  const valid = !!item && item.owner === dnd.owner && railInstructionIsAvailable(dnd.latest.current.getState(), instruction(item))
  useLayoutEffect(() => { if (over && item) dnd.updatePreview(instruction(item)) }, [dnd, over, item, instruction])
  if (!valid) return null
  return <div ref={(node) => { drop(node) }} data-testid={testId} aria-hidden="true" className={`absolute inset-x-0 z-10 h-2 ${operation === "reorder-before" ? "-top-2" : "-bottom-2"}`} />
}
