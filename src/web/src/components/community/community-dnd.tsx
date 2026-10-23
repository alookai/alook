"use client"

import { useContext, useEffect, useMemo, type ReactNode, type RefObject } from "react"
import { DndContext, DndProvider, useDragDropManager } from "react-dnd"
import { createVerticalStrength, useDndScrolling } from "react-dnd-scrolling"
import { HTML5Backend } from "react-dnd-html5-backend"
import { TouchBackend } from "react-dnd-touch-backend"
import { MouseTransition, MultiBackend, TouchTransition } from "dnd-multi-backend"

export const communityDndOptions = {
  backends: [
    { id: "html5", backend: HTML5Backend, transition: MouseTransition },
    {
      id: "touch", backend: TouchBackend, transition: TouchTransition,
      options: { delayTouchStart: 650, touchSlop: 8, enableMouseEvents: false, enableKeyboardEvents: true, ignoreContextMenu: true },
    },
  ],
}

export function CommunityDndProvider({ children }: { children: ReactNode }) {
  const { dragDropManager } = useContext(DndContext)
  if (dragDropManager) return children
  return <DndProvider backend={MultiBackend} options={communityDndOptions}>{children}</DndProvider>
}

export function useDndCancellation(onCancel: () => void) {
  const manager = useDragDropManager()
  useEffect(() => {
    const cancel = () => {
      if (!manager.getMonitor().isDragging()) return
      onCancel()
      manager.getActions().endDrag()
    }
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel() }
    const visibility = () => { if (document.hidden) cancel() }
    window.addEventListener("keydown", key, true)
    window.addEventListener("blur", cancel)
    window.addEventListener("touchcancel", cancel)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      window.removeEventListener("keydown", key, true)
      window.removeEventListener("blur", cancel)
      window.removeEventListener("touchcancel", cancel)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [manager, onCancel])
}

export function useCommunityDndScrolling(ref: RefObject<HTMLElement | null>, itemType: string) {
  const manager = useDragDropManager()
  const options = useMemo(() => {
    const strength = createVerticalStrength(80)
    return {
      horizontalStrength: () => 0,
      verticalStrength: (box: Parameters<typeof strength>[0], point: Parameters<typeof strength>[1]) => manager.getMonitor().getItemType() === itemType ? strength(box, point) : 0,
    }
  }, [manager, itemType])
  useDndScrolling(ref, options)
}
