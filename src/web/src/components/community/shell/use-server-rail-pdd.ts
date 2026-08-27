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
import type { RailEntity, RailInstruction } from "@/lib/community/server-rail-model"

type RailData = Record<string | symbol, unknown>

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

function operationAvailability(source: RailEntity | null, target: RailEntity): {
  "reorder-before": Availability
  "reorder-after": Availability
  combine: Availability
} {
  const canReorder = source?.kind === target.kind
  const canCombine = source?.kind === "server"
    && (target.kind === "server" || target.kind === "folder")
  return {
    "reorder-before": canReorder ? "available" : "not-available",
    "reorder-after": canReorder ? "available" : "not-available",
    combine: canCombine ? "available" : "not-available",
  }
}

function sameInstruction(left: RailInstruction | null, right: RailInstruction | null): boolean {
  return left?.operation === right?.operation
    && sameEntity(left?.source ?? null, right?.source ?? null)
    && sameEntity(left?.target ?? null, right?.target ?? null)
}

export function useServerRailPdd({
  scrollRef,
  onDragStart,
  onPreview,
  onDrop,
  onCancel,
  onHoverExpand,
}: {
  scrollRef: RefObject<HTMLElement | null>
  onDragStart: (source: RailEntity) => void
  onPreview: (instruction: RailInstruction | null) => void
  onDrop: (instruction: RailInstruction) => void
  onCancel: () => void
  onHoverExpand: (folderId: string) => void
}) {
  const handlersRef = useRef({ onDragStart, onPreview, onDrop, onCancel, onHoverExpand })
  useEffect(() => {
    handlersRef.current = { onDragStart, onPreview, onDrop, onCancel, onHoverExpand }
  }, [onCancel, onDragStart, onDrop, onHoverExpand, onPreview])
  const previewRef = useRef<RailInstruction | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverFolderRef = useRef<string | null>(null)

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

  const registerItem = useCallback((
    entity: RailEntity,
    element: HTMLElement,
    dragHandle: HTMLElement,
  ) => {
    const cleanupDraggable = draggable({
      element,
      dragHandle,
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
          operations: operationAvailability(railEntityFromData(source.data), entity),
        },
      ),
    })
    return () => {
      cleanupTarget()
      cleanupDraggable()
    }
  }, [])

  useEffect(() => monitorForElements({
    canMonitor: ({ source }) => railEntityFromData(source.data) !== null,
    onDragStart: ({ source }) => {
      const entity = railEntityFromData(source.data)
      if (entity) handlersRef.current.onDragStart(entity)
    },
    onDrag: ({ source, location }) => {
      updatePreview(railInstructionFromRecords(source.data, location.current.dropTargets))
    },
    onDropTargetChange: ({ source, location }) => {
      updatePreview(railInstructionFromRecords(source.data, location.current.dropTargets))
    },
    onDrop: ({ source, location }) => {
      const instruction = railInstructionFromRecords(source.data, location.current.dropTargets)
      clearHover()
      previewRef.current = null
      handlersRef.current.onPreview(null)
      if (instruction) handlersRef.current.onDrop(instruction)
      else handlersRef.current.onCancel()
    },
  }), [clearHover, updatePreview])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    return autoScrollForElements({
      element,
      getAllowedAxis: () => "vertical",
      getConfiguration: () => ({ maxScrollSpeed: "fast" }),
    })
  }, [scrollRef])

  useEffect(() => () => clearHover(), [clearHover])

  return { registerItem }
}
