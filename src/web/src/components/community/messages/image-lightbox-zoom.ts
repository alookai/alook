"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react"

export type ImageView = { scale: number; x: number; y: number }
type Point = { x: number; y: number }
type Bounds = { width: number; height: number }
const FIT_VIEW: ImageView = { scale: 1, x: 0, y: 0 }
const MAX_ZOOM = 8

function constrain(view: ImageView, bounds: Bounds): ImageView {
  const scale = Math.max(1, Math.min(MAX_ZOOM, view.scale))
  const maxX = bounds.width * (scale - 1) / 2
  const maxY = bounds.height * (scale - 1) / 2
  return {
    scale,
    x: Math.max(-maxX, Math.min(maxX, view.x)),
    y: Math.max(-maxY, Math.min(maxY, view.y)),
  }
}

function zoomAt(view: ImageView, scale: number, point: Point, bounds: Bounds): ImageView {
  const nextScale = Math.max(1, Math.min(MAX_ZOOM, scale))
  const ratio = nextScale / view.scale
  return constrain({
    scale: nextScale,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  }, bounds)
}

function midpoint(points: Point[]): Point {
  return points.length === 1 ? points[0] : {
    x: (points[0].x + points[1].x) / 2,
    y: (points[0].y + points[1].y) / 2,
  }
}

function distance(points: Point[]): number {
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
}

export function useImageLightboxZoom(enabled: boolean) {
  const frameRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const [view, setView] = useAtom(useCreateAtom<ImageView>(FIT_VIEW))
  const currentView = useRef(FIT_VIEW)

  const apply = useCallback((next: ImageView) => {
    const bounds = frameRef.current?.getBoundingClientRect()
    const constrained = bounds ? constrain(next, bounds) : FIT_VIEW
    currentView.current = constrained
    setView(constrained)
  }, [setView])

  const reset = useCallback(() => {
    pointers.current.clear()
    apply(FIT_VIEW)
  }, [apply])

  const zoomTo = useCallback((scale: number, point?: Point) => {
    const bounds = frameRef.current?.getBoundingClientRect()
    if (!bounds) return
    const anchor = point ? {
      x: point.x - bounds.left - bounds.width / 2,
      y: point.y - bounds.top - bounds.height / 2,
    } : { x: 0, y: 0 }
    apply(zoomAt(currentView.current, scale, anchor, bounds))
  }, [apply])

  useEffect(() => {
    if (!enabled) {
      reset()
      return
    }
    const frame = frameRef.current
    if (!frame) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1
      const factor = event.ctrlKey ? 0.005 : 0.002
      zoomTo(currentView.current.scale * Math.exp(-event.deltaY * unit * factor), {
        x: event.clientX, y: event.clientY,
      })
    }
    const activePointers = pointers.current
    frame.addEventListener("wheel", wheel, { passive: false })
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      pointers.current.clear()
      apply(currentView.current)
    }) : undefined
    observer?.observe(frame)
    return () => {
      frame.removeEventListener("wheel", wheel)
      observer?.disconnect()
      activePointers.clear()
    }
  }, [apply, enabled, reset, zoomTo])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || pointers.current.size >= 2) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const before = [...pointers.current.values()]
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const after = [...pointers.current.values()]
    const oldMidpoint = midpoint(before)
    const newMidpoint = midpoint(after)
    const bounds = event.currentTarget.getBoundingClientRect()
    const anchor = {
      x: oldMidpoint.x - bounds.left - bounds.width / 2,
      y: oldMidpoint.y - bounds.top - bounds.height / 2,
    }
    const ratio = before.length === 2 ? distance(after) / Math.max(1, distance(before)) : 1
    const next = zoomAt(currentView.current, currentView.current.scale * ratio, anchor, bounds)
    apply({ ...next, x: next.x + newMidpoint.x - oldMidpoint.x, y: next.y + newMidpoint.y - oldMidpoint.y })
  }

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!enabled || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === "+" || event.key === "=") zoomTo(currentView.current.scale * 1.5)
    else if (event.key === "-") zoomTo(currentView.current.scale / 1.5)
    else if (event.key === "0") reset()
    else if (event.key.startsWith("Arrow")) {
      const next = currentView.current
      apply({
        ...next,
        x: next.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
        y: next.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0),
      })
    } else return
    event.preventDefault()
  }

  return {
    frameRef,
    view,
    reset,
    zoomIn: () => zoomTo(currentView.current.scale * 1.5),
    zoomOut: () => zoomTo(currentView.current.scale / 1.5),
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
      onKeyDown,
      onDoubleClick: (event: MouseEvent<HTMLDivElement>) => {
        if (enabled) zoomTo(currentView.current.scale > 1 ? 1 : 2, { x: event.clientX, y: event.clientY })
      },
    },
  }
}
