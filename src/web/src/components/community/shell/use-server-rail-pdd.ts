"use client"

import { useCallback, useEffect, useRef, type RefObject } from "react"
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element"
import {
  attachInstruction,
  extractInstruction,
  type Availability,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/list-item"
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter"
import {
  railInstructionIsAvailable,
  railOperationAvailability,
  type RailEntity,
  type RailInstruction,
  type RailOperation,
  type RailState,
} from "@/lib/community/server-rail-model"

type RailData = Record<string | symbol, unknown>

export const SERVER_RAIL_TOUCH_HOLD_MS = 450
export const SERVER_RAIL_TOUCH_DRIFT_PX = 10
const TOUCH_DRAG_PREVIEW_SELECTOR = "[data-rail-drag-preview]"

type TouchDragPreview = {
  element: HTMLElement
  width: number
  height: number
}

function positionTouchDragPreview(
  preview: TouchDragPreview,
  clientX: number,
  clientY: number,
) {
  preview.element.style.transform = `translate3d(${clientX - preview.width / 2}px, ${clientY - preview.height / 2}px, 0)`
}

function createTouchDragPreview(
  dragHandle: HTMLElement,
  entity: RailEntity,
  clientX: number,
  clientY: number,
): TouchDragPreview | null {
  const source = dragHandle.querySelector<HTMLElement>(TOUCH_DRAG_PREVIEW_SELECTOR)
  if (!source) return null
  const rect = source.getBoundingClientRect()
  const element = source.cloneNode(true) as HTMLElement
  element.removeAttribute("data-rail-drag-preview")
  element.setAttribute("data-rail-floating-preview", entity.kind)
  element.setAttribute("aria-hidden", "true")
  Object.assign(element.style, {
    position: "fixed",
    left: "0",
    top: "0",
    zIndex: "100",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    transition: "none",
    willChange: "transform",
  })
  const preview = { element, width: rect.width, height: rect.height }
  positionTouchDragPreview(preview, clientX, clientY)
  document.body.appendChild(element)
  return preview
}

export function railTouchMoveIntent({
  dragging,
  distance,
  touchCount,
}: {
  dragging: boolean
  distance: number
  touchCount: number
}): "wait" | "scroll" | "drag" | "cancel" {
  if (touchCount !== 1) return "cancel"
  if (dragging) return "drag"
  return distance > SERVER_RAIL_TOUCH_DRIFT_PX ? "scroll" : "wait"
}

function sameEntity(left: RailEntity | null, right: RailEntity | null): boolean {
  return left?.kind === right?.kind && left?.id === right?.id
}

export function railEntityFromData(data: RailData): RailEntity | null {
  const kind = data.railKind
  const id = data.railId
  if ((kind !== "server" && kind !== "folder") || typeof id !== "string") return null
  return { kind, id }
}

export function railInstructionFromRecords(
  sourceData: RailData,
  targets: readonly { data: RailData }[],
): RailInstruction | null {
  const source = railEntityFromData(sourceData)
  const targetRecord = targets[0]
  if (!source || !targetRecord) return null
  const target = railEntityFromData(targetRecord.data)
  const instruction = extractInstruction(targetRecord.data)
  if (!target || !instruction || instruction.blocked || sameEntity(source, target)) return null
  return { operation: instruction.operation, source, target }
}

function pddAvailability(state: RailState, source: RailEntity | null, target: RailEntity): {
  "reorder-before": Availability
  "reorder-after": Availability
  combine: Availability
} {
  const available = railOperationAvailability(state, source, target)
  return {
    "reorder-before": available["reorder-before"] ? "available" : "not-available",
    "reorder-after": available["reorder-after"] ? "available" : "not-available",
    combine: available.combine ? "available" : "not-available",
  }
}

function sameInstruction(left: RailInstruction | null, right: RailInstruction | null): boolean {
  return left?.operation === right?.operation
    && sameEntity(left?.source ?? null, right?.source ?? null)
    && sameEntity(left?.target ?? null, right?.target ?? null)
}

export function useServerRailPdd({
  scrollRef,
  getState,
  canStart,
  getEntityLabel,
  onDragStart,
  onPreview,
  onDrop,
  onCancel,
  onHoverExpand,
  onAnnounce,
}: {
  scrollRef: RefObject<HTMLElement | null>
  getState: () => RailState
  canStart: () => boolean
  getEntityLabel: (entity: RailEntity) => string
  onDragStart: (source: RailEntity) => void
  onPreview: (instruction: RailInstruction | null) => void
  onDrop: (instruction: RailInstruction) => void
  onCancel: () => void
  onHoverExpand: (folderId: string) => void
  onAnnounce: (message: string) => void
}) {
  const handlersRef = useRef({
    getState,
    canStart,
    getEntityLabel,
    onDragStart,
    onPreview,
    onDrop,
    onCancel,
    onHoverExpand,
    onAnnounce,
  })
  useEffect(() => {
    handlersRef.current = {
      getState,
      canStart,
      getEntityLabel,
      onDragStart,
      onPreview,
      onDrop,
      onCancel,
      onHoverExpand,
      onAnnounce,
    }
  }, [canStart, getEntityLabel, getState, onAnnounce, onCancel, onDragStart, onDrop, onHoverExpand, onPreview])
  const previewRef = useRef<RailInstruction | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverFolderRef = useRef<string | null>(null)
  const itemsRef = useRef(new Map<HTMLElement, { entity: RailEntity; handle: HTMLElement }>())
  const activeRef = useRef<{ sensor: "native" | "touch" | "keyboard"; source: RailEntity } | null>(null)
  const suppressClickUntilRef = useRef(0)
  const selectionStyleRef = useRef<string | null>(null)
  const touchRef = useRef<{
    entity: RailEntity
    identifier: number
    startX: number
    startY: number
    clientX: number
    clientY: number
    dragging: boolean
    timer: ReturnType<typeof setTimeout> | null
    frame: number | null
    preview: TouchDragPreview | null
  } | null>(null)

  const clearHover = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    hoverFolderRef.current = null
  }, [])

  const updatePreview = useCallback((instruction: RailInstruction | null) => {
    if (sameInstruction(previewRef.current, instruction)) return
    previewRef.current = instruction
    handlersRef.current.onPreview(instruction)
    const folderId = instruction?.operation === "combine" && instruction.target.kind === "folder"
      ? instruction.target.id
      : null
    if (!folderId) {
      clearHover()
      return
    }
    if (hoverFolderRef.current === folderId && hoverTimerRef.current) return
    clearHover()
    hoverFolderRef.current = folderId
    hoverTimerRef.current = setTimeout(() => {
      handlersRef.current.onHoverExpand(folderId)
      hoverTimerRef.current = null
    }, 500)
  }, [clearHover])

  const restoreSelection = useCallback(() => {
    if (selectionStyleRef.current === null) return
    document.documentElement.style.userSelect = selectionStyleRef.current
    selectionStyleRef.current = null
  }, [])

  const clearTouch = useCallback(() => {
    const touch = touchRef.current
    if (touch?.timer) clearTimeout(touch.timer)
    if (touch?.frame !== null && touch?.frame !== undefined) cancelAnimationFrame(touch.frame)
    touch?.preview?.element.remove()
    touchRef.current = null
    restoreSelection()
  }, [restoreSelection])

  const cancelActive = useCallback((announcement?: string) => {
    if (!activeRef.current && !touchRef.current) return
    activeRef.current = null
    clearTouch()
    clearHover()
    updatePreview(null)
    handlersRef.current.onCancel()
    if (announcement) handlersRef.current.onAnnounce(announcement)
  }, [clearHover, clearTouch, updatePreview])

  const begin = useCallback((source: RailEntity, sensor: "native" | "touch" | "keyboard") => {
    if (activeRef.current || !handlersRef.current.canStart()) {
      handlersRef.current.onAnnounce("A server rail move is already being saved")
      return false
    }
    activeRef.current = { sensor, source }
    handlersRef.current.onDragStart(source)
    if (sensor === "keyboard") {
      handlersRef.current.onAnnounce(
        `${handlersRef.current.getEntityLabel(source)} picked up. Use arrow keys to choose a position, Space or Enter to drop, and Escape to cancel.`,
      )
    }
    return true
  }, [])

  const describePreview = useCallback((instruction: RailInstruction) => {
    const source = handlersRef.current.getEntityLabel(instruction.source)
    const target = handlersRef.current.getEntityLabel(instruction.target)
    if (instruction.operation === "combine") return `${source} will move into ${target}`
    return `${source} will move ${instruction.operation === "reorder-before" ? "before" : "after"} ${target}`
  }, [])

  const setPreview = useCallback((instruction: RailInstruction | null, announcePreview = false) => {
    const valid = instruction && railInstructionIsAvailable(
      handlersRef.current.getState(),
      instruction,
    ) ? instruction : null
    const changed = !sameInstruction(previewRef.current, valid)
    updatePreview(valid)
    if (changed && valid && announcePreview) {
      handlersRef.current.onAnnounce(describePreview(valid))
    }
  }, [describePreview, updatePreview])

  const finishDrop = useCallback((instruction: RailInstruction | null) => {
    const valid = instruction && railInstructionIsAvailable(
      handlersRef.current.getState(),
      instruction,
    ) ? instruction : null
    activeRef.current = null
    clearTouch()
    clearHover()
    updatePreview(null)
    if (valid) handlersRef.current.onDrop(valid)
    else handlersRef.current.onCancel()
  }, [clearHover, clearTouch, updatePreview])

  const itemAtPoint = useCallback((source: RailEntity, clientX: number, clientY: number) => {
    const targetElement = document.elementsFromPoint(clientX, clientY)
      .find((element) => itemsRef.current.has(element as HTMLElement)) as HTMLElement | undefined
    if (!targetElement) return null
    const target = itemsRef.current.get(targetElement)!.entity
    if (sameEntity(source, target)) return null
    const availability = railOperationAvailability(handlersRef.current.getState(), source, target)
    const rect = targetElement.getBoundingClientRect()
    const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5
    let operation: RailOperation | null = null
    if (ratio < 0.25 && availability["reorder-before"]) operation = "reorder-before"
    else if (ratio > 0.75 && availability["reorder-after"]) operation = "reorder-after"
    else if (availability.combine) operation = "combine"
    else if (ratio < 0.5 && availability["reorder-before"]) operation = "reorder-before"
    else if (availability["reorder-after"]) operation = "reorder-after"
    return operation ? { operation, source, target } satisfies RailInstruction : null
  }, [])

  const runTouchFrame = useCallback(function frame() {
    const touch = touchRef.current
    const scroll = scrollRef.current
    if (!touch?.dragging || !scroll) return
    const rect = scroll.getBoundingClientRect()
    const edge = 32
    let delta = 0
    if (touch.clientY < rect.top + edge) {
      delta = -Math.ceil(12 * (1 - Math.max(0, touch.clientY - rect.top) / edge))
    } else if (touch.clientY > rect.bottom - edge) {
      delta = Math.ceil(12 * (1 - Math.max(0, rect.bottom - touch.clientY) / edge))
    }
    if (delta !== 0) {
      scroll.scrollTop += delta
      setPreview(itemAtPoint(touch.entity, touch.clientX, touch.clientY))
    }
    touch.frame = requestAnimationFrame(frame)
  }, [itemAtPoint, scrollRef, setPreview])

  const orderedItems = useCallback(() => [...itemsRef.current.values()].sort((left, right) => {
    const leftRect = left.handle.getBoundingClientRect()
    const rightRect = right.handle.getBoundingClientRect()
    return leftRect.top - rightRect.top || leftRect.left - rightRect.left
  }), [])

  const keyboardInstruction = useCallback((source: RailEntity, direction: -1 | 1) => {
    const items = orderedItems()
    const currentTarget = previewRef.current?.target ?? source
    const currentIndex = items.findIndex(({ entity }) => sameEntity(entity, currentTarget))
    for (
      let index = currentIndex + direction;
      index >= 0 && index < items.length;
      index += direction
    ) {
      const target = items[index]!.entity
      if (sameEntity(source, target)) continue
      const availability = railOperationAvailability(handlersRef.current.getState(), source, target)
      const operation = target.kind === "folder" && availability.combine
        ? "combine"
        : direction < 0 && availability["reorder-before"]
          ? "reorder-before"
          : direction > 0 && availability["reorder-after"]
            ? "reorder-after"
            : availability.combine
              ? "combine"
              : null
      if (operation) return { operation, source, target } satisfies RailInstruction
    }
    return null
  }, [orderedItems])

  const handleKeyboardCommand = useCallback((event: KeyboardEvent, source: RailEntity) => {
    if (event.key === "Escape") {
      event.preventDefault()
      cancelActive(`${handlersRef.current.getEntityLabel(source)} move cancelled`)
      return true
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      finishDrop(previewRef.current)
      return true
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault()
      setPreview(keyboardInstruction(source, event.key === "ArrowUp" ? -1 : 1), true)
      return true
    }
    const current = previewRef.current
    if (!current || current.target.kind !== "server" || source.kind !== "server") return false
    const availability = railOperationAvailability(
      handlersRef.current.getState(),
      source,
      current.target,
    )
    if (event.key === "ArrowRight" && availability.combine) {
      event.preventDefault()
      setPreview({ ...current, operation: "combine" }, true)
      return true
    }
    if (event.key !== "ArrowLeft") return false
    const operation = availability["reorder-before"]
      ? "reorder-before"
      : availability["reorder-after"]
        ? "reorder-after"
        : null
    if (!operation) return false
    event.preventDefault()
    setPreview({ ...current, operation }, true)
    return true
  }, [cancelActive, finishDrop, keyboardInstruction, setPreview])

  const registerItem = useCallback((
    entity: RailEntity,
    element: HTMLElement,
    dragHandle: HTMLElement,
  ) => {
    itemsRef.current.set(element, { entity, handle: dragHandle })
    if (
      activeRef.current?.sensor === "keyboard"
      && sameEntity(activeRef.current.source, entity)
    ) dragHandle.focus({ preventScroll: true })
    const cleanupDraggable = draggable({
      element,
      dragHandle,
      canDrag: () => !touchRef.current && !activeRef.current && handlersRef.current.canStart(),
      getInitialData: () => ({ railKind: entity.kind, railId: entity.id }),
    })
    const cleanupTarget = dropTargetForElements({
      element,
      canDrop: ({ source }) => !sameEntity(railEntityFromData(source.data), entity),
      getIsSticky: () => false,
      getData: ({ input, element: targetElement, source }) => attachInstruction(
        { railKind: entity.kind, railId: entity.id },
        {
          input,
          element: targetElement,
          axis: "vertical",
          operations: pddAvailability(
            handlersRef.current.getState(),
            railEntityFromData(source.data),
            entity,
          ),
        },
      ),
    })

    const suppressTouchMenu = (event: TouchEvent) => {
      // Base UI owns a separate 500 ms touch timer on ContextMenuTrigger.
      // Keep the event native (and therefore scrollable), but do not let it
      // reach that trigger: the rail's 450 ms hold is exclusively drag pickup.
      event.stopPropagation()
    }
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        if (touchRef.current || activeRef.current?.sensor === "touch") cancelActive()
        return
      }
      if (touchRef.current || activeRef.current) return
      if (!handlersRef.current.canStart()) return
      suppressClickUntilRef.current = 0
      const touch = event.touches[0]!
      const pending = {
        entity,
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        clientX: touch.clientX,
        clientY: touch.clientY,
        dragging: false,
        timer: null as ReturnType<typeof setTimeout> | null,
        frame: null as number | null,
        preview: null as TouchDragPreview | null,
      }
      pending.timer = setTimeout(() => {
        if (touchRef.current !== pending) return
        pending.timer = null
        if (!begin(entity, "touch")) {
          clearTouch()
          return
        }
        pending.dragging = true
        pending.preview = createTouchDragPreview(
          dragHandle,
          entity,
          pending.clientX,
          pending.clientY,
        )
        selectionStyleRef.current = document.documentElement.style.userSelect
        document.documentElement.style.userSelect = "none"
        document.getSelection()?.removeAllRanges()
        pending.frame = requestAnimationFrame(runTouchFrame)
      }, SERVER_RAIL_TOUCH_HOLD_MS)
      touchRef.current = pending
    }
    const onTouchMove = (event: TouchEvent) => {
      const pending = touchRef.current
      if (!pending || !sameEntity(pending.entity, entity)) return
      if (event.touches.length !== 1) {
        cancelActive()
        return
      }
      const touch = [...event.touches].find((candidate) => candidate.identifier === pending.identifier)
      if (!touch) {
        cancelActive()
        return
      }
      pending.clientX = touch.clientX
      pending.clientY = touch.clientY
      if (pending.preview) {
        positionTouchDragPreview(pending.preview, touch.clientX, touch.clientY)
      }
      const exactDistance = Math.hypot(touch.clientX - pending.startX, touch.clientY - pending.startY)
      const exactIntent = railTouchMoveIntent({
        dragging: pending.dragging,
        distance: exactDistance,
        touchCount: event.touches.length,
      })
      if (exactIntent === "scroll") {
        clearTouch()
        return
      }
      if (exactIntent === "wait") return
      event.preventDefault()
      setPreview(itemAtPoint(entity, touch.clientX, touch.clientY))
    }
    const onTouchEnd = (event: TouchEvent) => {
      const pending = touchRef.current
      if (!pending || !sameEntity(pending.entity, entity)) return
      const touch = [...event.changedTouches].find((candidate) => candidate.identifier === pending.identifier)
      if (pending.dragging) {
        const clientX = touch?.clientX ?? pending.clientX
        const clientY = touch?.clientY ?? pending.clientY
        setPreview(itemAtPoint(entity, clientX, clientY))
        suppressClickUntilRef.current = Date.now() + 800
        finishDrop(itemAtPoint(entity, clientX, clientY))
      } else {
        event.preventDefault()
        clearTouch()
        dragHandle.click()
      }
    }
    const onTouchCancel = () => cancelActive()
    const onContextMenu = (event: MouseEvent) => {
      const pending = touchRef.current
      if (
        (pending && sameEntity(pending.entity, entity))
        || (activeRef.current?.sensor === "touch" && sameEntity(activeRef.current.source, entity))
        || Date.now() < suppressClickUntilRef.current
      ) {
        event.preventDefault()
        event.stopPropagation()
        suppressClickUntilRef.current = Date.now() + 800
      }
    }
    const onClickCapture = (event: MouseEvent) => {
      if (Date.now() >= suppressClickUntilRef.current) return
      event.preventDefault()
      event.stopPropagation()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const active = activeRef.current
      if (!active) {
        if (event.key !== " " || !begin(entity, "keyboard")) return
        event.preventDefault()
        requestAnimationFrame(() => {
          const registered = [...itemsRef.current.values()]
            .find((item) => item.handle.isConnected && sameEntity(item.entity, entity))
          registered?.handle.focus({ preventScroll: true })
        })
        return
      }
      if (active.sensor !== "keyboard" || !sameEntity(active.source, entity)) return
      handleKeyboardCommand(event, entity)
    }
    element.addEventListener("touchstart", suppressTouchMenu, { passive: true })
    dragHandle.addEventListener("touchstart", suppressTouchMenu, { passive: true })
    dragHandle.addEventListener("touchstart", onTouchStart, { passive: true })
    dragHandle.addEventListener("touchmove", onTouchMove, { passive: false })
    dragHandle.addEventListener("touchend", onTouchEnd, { passive: false })
    dragHandle.addEventListener("touchcancel", onTouchCancel, { passive: true })
    dragHandle.addEventListener("contextmenu", onContextMenu)
    dragHandle.addEventListener("click", onClickCapture, true)
    dragHandle.addEventListener("keydown", onKeyDown)
    return () => {
      element.removeEventListener("touchstart", suppressTouchMenu)
      dragHandle.removeEventListener("touchstart", suppressTouchMenu)
      dragHandle.removeEventListener("touchstart", onTouchStart)
      dragHandle.removeEventListener("touchmove", onTouchMove)
      dragHandle.removeEventListener("touchend", onTouchEnd)
      dragHandle.removeEventListener("touchcancel", onTouchCancel)
      dragHandle.removeEventListener("contextmenu", onContextMenu)
      dragHandle.removeEventListener("click", onClickCapture, true)
      dragHandle.removeEventListener("keydown", onKeyDown)
      itemsRef.current.delete(element)
      // Lazy context-menu activation briefly remounts the same rail entity.
      // Defer cancellation until the replacement registration has had a chance
      // to land, while still cancelling when an entity truly leaves the rail.
      queueMicrotask(() => {
        const stillRegistered = [...itemsRef.current.values()]
          .some((item) => sameEntity(item.entity, entity))
        if (!stillRegistered && (
          sameEntity(touchRef.current?.entity ?? null, entity)
          || sameEntity(activeRef.current?.source ?? null, entity)
        )) cancelActive()
      })
      cleanupTarget()
      cleanupDraggable()
    }
  }, [begin, cancelActive, clearTouch, finishDrop, handleKeyboardCommand, itemAtPoint, runTouchFrame, setPreview])

  useEffect(() => monitorForElements({
    canMonitor: ({ source }) => railEntityFromData(source.data) !== null,
    onDragStart: ({ source }) => {
      const entity = railEntityFromData(source.data)
      if (entity) begin(entity, "native")
    },
    onDrag: ({ source, location }) => {
      if (activeRef.current?.sensor !== "native") return
      setPreview(railInstructionFromRecords(source.data, location.current.dropTargets))
    },
    onDropTargetChange: ({ source, location }) => {
      if (activeRef.current?.sensor !== "native") return
      setPreview(railInstructionFromRecords(source.data, location.current.dropTargets))
    },
    onDrop: ({ source, location }) => {
      if (activeRef.current?.sensor !== "native") return
      const instruction = railInstructionFromRecords(source.data, location.current.dropTargets)
      finishDrop(instruction)
    },
  }), [begin, finishDrop, setPreview])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const cancelPendingTouchForNativeScroll = () => {
      const pending = touchRef.current
      if (pending && !pending.dragging) clearTouch()
    }
    element.addEventListener("scroll", cancelPendingTouchForNativeScroll, { passive: true })
    const cleanupAutoScroll = autoScrollForElements({
      element,
      getAllowedAxis: () => "vertical",
      getConfiguration: () => ({ maxScrollSpeed: "fast" }),
    })
    return () => {
      element.removeEventListener("scroll", cancelPendingTouchForNativeScroll)
      cleanupAutoScroll()
    }
  }, [clearTouch, scrollRef])

  useEffect(() => {
    const cancel = () => cancelActive()
    const cancelWhenHidden = () => {
      if (document.visibilityState === "hidden") cancelActive()
    }
    const handleActiveKeyboardDrag = (event: KeyboardEvent) => {
      const active = activeRef.current
      if (active?.sensor !== "keyboard") return
      if (handleKeyboardCommand(event, active.source)) event.stopPropagation()
    }
    window.addEventListener("blur", cancel)
    document.addEventListener("visibilitychange", cancelWhenHidden)
    document.addEventListener("keydown", handleActiveKeyboardDrag, true)
    return () => {
      window.removeEventListener("blur", cancel)
      document.removeEventListener("visibilitychange", cancelWhenHidden)
      document.removeEventListener("keydown", handleActiveKeyboardDrag, true)
      cancelActive()
    }
  }, [cancelActive, handleKeyboardCommand])

  useEffect(() => {
    if (!canStart()) cancelActive()
  }, [canStart, cancelActive])

  return { registerItem }
}
