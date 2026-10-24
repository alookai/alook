"use client"

import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react"
import type { ContextMenu } from "@base-ui/react/context-menu"
import { DndContext } from "react-dnd"
import { communityTouchHoldDelay } from "./community-dnd"

type Options = {
  canOpen: boolean
  canDrag: () => boolean
  suppressOpen: () => boolean
}

export function useDndContextMenu(options: Options) {
  const { dragDropManager: manager } = useContext(DndContext)
  const latest = useRef(options)
  const actionsRef = useRef<ContextMenu.Root.Actions | null>(null)
  const hold = useRef<{ node: HTMLElement; x: number; y: number; ready: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const clearHold = useCallback(() => {
    clearTimer()
    hold.current = null
  }, [clearTimer])
  useLayoutEffect(() => {
    latest.current = options
    if (!options.canOpen || !options.canDrag()) clearHold()
  })
  useEffect(() => {
    if (options.canOpen) return
    actionsRef.current?.close()
    actionsRef.current?.unmount()
  }, [options.canOpen])
  useEffect(() => {
    let dragging = false
    const closeForDrag = () => {
      const active = manager?.getMonitor().isDragging() ?? false
      const started = active && !dragging
      dragging = active
      if (!started) return
      clearHold()
      actionsRef.current?.close()
      actionsRef.current?.unmount()
    }
    const unsubscribe = manager?.getMonitor().subscribeToStateChange(closeForDrag)
    const visibility = () => { if (document.hidden) clearHold() }
    window.addEventListener("blur", clearHold)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      unsubscribe?.()
      window.removeEventListener("blur", clearHold)
      document.removeEventListener("visibilitychange", visibility)
      clearHold()
    }
  }, [manager, clearHold])
  const suppressed = () => manager?.getMonitor().isDragging() || latest.current.suppressOpen()
  const onOpenChange: NonNullable<ContextMenu.Root.Props["onOpenChange"]> = (open, details) => {
    if (open && (!latest.current.canOpen || suppressed())) details.cancel()
    if (!open) clearHold()
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
