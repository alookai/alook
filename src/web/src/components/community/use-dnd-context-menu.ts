"use client"

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, type ContextType } from "react"
import type { ContextMenu } from "@base-ui/react/context-menu"
import { DndContext } from "react-dnd"
import { communityTouchHoldDelay } from "./community-dnd"

type DragDropManager = NonNullable<ContextType<typeof DndContext>["dragDropManager"]>

type Options = {
  canOpen: boolean
  canDrag: () => boolean
  suppressOpen: () => boolean
}

const activeHoldCleanups = new Set<() => void>()

function handleSharedWindowBlur() {
  for (const cleanup of [...activeHoldCleanups]) cleanup()
}

function handleSharedVisibilityChange() {
  if (!document.hidden) return
  for (const cleanup of [...activeHoldCleanups]) cleanup()
}

function addHoldCleanup(cleanup: () => void) {
  if (activeHoldCleanups.has(cleanup)) return
  if (activeHoldCleanups.size === 0 && typeof window !== "undefined") {
    window.addEventListener("blur", handleSharedWindowBlur)
    document.addEventListener("visibilitychange", handleSharedVisibilityChange)
  }
  activeHoldCleanups.add(cleanup)
}

function removeHoldCleanup(cleanup: () => void) {
  if (!activeHoldCleanups.delete(cleanup)) return
  if (activeHoldCleanups.size === 0 && typeof window !== "undefined") {
    window.removeEventListener("blur", handleSharedWindowBlur)
    document.removeEventListener("visibilitychange", handleSharedVisibilityChange)
  }
}

type SharedDragStartEntry = {
  listeners: Set<() => void>
  dragging: boolean
  unsubscribe: () => void
}

const dragStartRegistry = new WeakMap<DragDropManager, SharedDragStartEntry>()

function addDragStartListener(manager: DragDropManager | undefined, listener: () => void) {
  if (!manager) return
  let entry = dragStartRegistry.get(manager)
  if (!entry) {
    const monitor = manager.getMonitor()
    const listeners = new Set<() => void>()
    const created: SharedDragStartEntry = {
      listeners,
      dragging: monitor.isDragging(),
      unsubscribe: () => {},
    }
    created.unsubscribe = monitor.subscribeToStateChange(() => {
      const active = monitor.isDragging()
      const started = active && !created.dragging
      created.dragging = active
      if (!started) return
      for (const fn of [...listeners]) fn()
    })
    entry = created
    dragStartRegistry.set(manager, entry)
  }
  entry.listeners.add(listener)
}

function removeDragStartListener(manager: DragDropManager | undefined, listener: () => void) {
  if (!manager) return
  const entry = dragStartRegistry.get(manager)
  if (!entry || !entry.listeners.delete(listener)) return
  if (entry.listeners.size === 0) {
    entry.unsubscribe()
    dragStartRegistry.delete(manager)
  }
}

export function useDndContextMenu(options: Options) {
  const { dragDropManager: manager } = useContext(DndContext)
  const latest = useRef(options)
  const managerRef = useRef(manager)
  const actionsRef = useRef<ContextMenu.Root.Actions | null>(null)
  const hold = useRef<{ node: HTMLElement; x: number; y: number; ready: boolean } | null>(null)
  const menuOpenRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const onDragStartRef = useRef<() => void>(() => {})
  const clearHoldRef = useRef<() => void>(() => {})
  const handleDragStart = useCallback(() => {
    onDragStartRef.current()
  }, [])
  const handleHoldCleanup = useCallback(() => {
    clearHoldRef.current()
  }, [])
  const syncDragSubscription = useCallback(() => {
    if (latest.current.canOpen || hold.current !== null || menuOpenRef.current) {
      addDragStartListener(managerRef.current, handleDragStart)
    } else {
      removeDragStartListener(managerRef.current, handleDragStart)
    }
  }, [handleDragStart])
  const clearHold = useCallback(() => {
    clearTimer()
    hold.current = null
    removeHoldCleanup(handleHoldCleanup)
    syncDragSubscription()
  }, [clearTimer, handleHoldCleanup, syncDragSubscription])
  useLayoutEffect(() => {
    clearHoldRef.current = clearHold
    onDragStartRef.current = () => {
      clearHold()
      menuOpenRef.current = false
      syncDragSubscription()
      actionsRef.current?.close()
      actionsRef.current?.unmount()
    }
    const previousManager = managerRef.current
    if (previousManager !== manager) {
      removeDragStartListener(previousManager, handleDragStart)
      managerRef.current = manager
    }
    latest.current = options
    syncDragSubscription()
    if (!options.canOpen || !options.canDrag()) clearHold()
  }, [clearHold, handleDragStart, manager, options, syncDragSubscription])
  useEffect(() => {
    if (options.canOpen) return
    menuOpenRef.current = false
    syncDragSubscription()
    actionsRef.current?.close()
    actionsRef.current?.unmount()
  }, [options.canOpen, syncDragSubscription])
  useEffect(() => () => {
    menuOpenRef.current = false
    clearHold()
    removeDragStartListener(managerRef.current, handleDragStart)
  }, [clearHold, handleDragStart])
  const suppressed = () => managerRef.current?.getMonitor().isDragging() || latest.current.suppressOpen()
  const onOpenChange: NonNullable<ContextMenu.Root.Props["onOpenChange"]> = (open, details) => {
    if (open && (!latest.current.canOpen || suppressed())) {
      details.cancel()
      return
    }
    menuOpenRef.current = open
    if (!open) clearHold()
    else syncDragSubscription()
  }
  const triggerProps: Pick<ContextMenu.Trigger.Props, "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel" | "onContextMenu"> = {
    onTouchStart: (event) => {
      clearHold()
      if (!latest.current.canDrag()) return
      event.preventBaseUIHandler()
      if (!latest.current.canOpen || event.touches.length !== 1 || suppressed()) return
      const touch = event.touches[0]
      const current = { node: event.currentTarget, x: touch.clientX, y: touch.clientY, ready: false }
      hold.current = current
      addHoldCleanup(handleHoldCleanup)
      syncDragSubscription()
      timer.current = setTimeout(() => {
        timer.current = null
        if (hold.current !== current || !current.node.isConnected || !latest.current.canOpen || !latest.current.canDrag() || suppressed()) return
        current.ready = true
        current.node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: current.x, clientY: current.y }))
      }, communityTouchHoldDelay)
    },
    onTouchMove: () => { if (!hold.current?.ready) clearTimer() },
    onTouchEnd: (event) => {
      if (hold.current?.ready) event.preventDefault()
      clearHold()
    },
    onTouchCancel: clearHold,
    onContextMenu: (event) => {
      if (suppressed() || (hold.current && !hold.current.ready)) {
        event.preventDefault()
        event.preventBaseUIHandler()
      }
    },
  }
  return { actionsRef, onOpenChange, triggerProps }
}
