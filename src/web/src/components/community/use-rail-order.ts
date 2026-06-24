"use client"

import { useState } from "react"
import { arrayMove } from "@dnd-kit/sortable"
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core"

export const FOLDER_ID = "folder"

/**
 * Pure reorder for the server rail's flat id list (server ids + the folder
 * placeholder, all sortable together). Returns a new array; returns the input
 * unchanged when the move is a no-op or either id is missing. Exported for tests.
 */
export function reorderRail(order: string[], activeId: string, overId: string): string[] {
  if (activeId === overId) return order
  const from = order.indexOf(activeId)
  const to = order.indexOf(overId)
  if (from === -1 || to === -1) return order
  return arrayMove(order, from, to)
}

/**
 * Server-rail dnd state: a flat sortable order, plus folder open/close that
 * auto-collapses while the folder icon is dragged and reopens once it settles.
 */
export function useRailOrder(serverIds: string[]) {
  const [order, setOrder] = useState<string[]>([...serverIds, FOLDER_ID])
  const [folderOpen, setFolderOpen] = useState(false)
  const [reopenAfterDrag, setReopenAfterDrag] = useState(false)

  const onDragStart = (e: DragStartEvent) => {
    if (e.active.id === FOLDER_ID && folderOpen) {
      setReopenAfterDrag(true)
      setFolderOpen(false)
    }
  }

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (over) setOrder((prev) => reorderRail(prev, String(active.id), String(over.id)))
    if (reopenAfterDrag) {
      setFolderOpen(true)
      setReopenAfterDrag(false)
    }
  }

  // append a new server id just before the folder placeholder
  const appendServer = (id: string) =>
    setOrder((prev) => {
      const folderAt = prev.indexOf(FOLDER_ID)
      if (folderAt === -1) return [...prev, id]
      return [...prev.slice(0, folderAt), id, ...prev.slice(folderAt)]
    })

  return { order, folderOpen, setFolderOpen, onDragStart, onDragEnd, appendServer }
}
