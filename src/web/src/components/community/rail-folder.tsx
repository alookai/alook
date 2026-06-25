"use client"

import { useState } from "react"
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { RailIndicator } from "./rail-indicator"
import { RailTooltip } from "./rail-tooltip"
import { FOLDER_ID } from "./use-rail-order"
import type { FolderServer, MobileZone } from "./_types"

// Server folder — collapsed shows a 2×2 mini-icon grid; clicking expands the group
// to reveal its member servers stacked below.
export function RailFolder({
  open, onToggle, activeId, onSelect, setMobileZone, folderServers, onUngroup,
}: {
  open: boolean
  onToggle: () => void
  activeId: string
  onSelect: (id: string) => void
  setMobileZone?: (z: MobileZone) => void
  folderServers: FolderServer[]
  onUngroup?: () => void
}) {
  const [items, setItems] = useState(folderServers)
  // the folder icon is sortable within the rail's outer SortableContext
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: FOLDER_ID })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  // inner context reorders the member servers (only mounted while expanded)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const onInnerDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setItems((prev) => {
      const from = prev.findIndex((s) => s.id === active.id)
      const to = prev.findIndex((s) => s.id === over.id)
      if (from === -1 || to === -1) return prev
      return arrayMove(prev, from, to)
    })
  }
  const pick = (id: string) => { onSelect(id); setMobileZone?.("channels") }
  return (
    <div ref={setNodeRef} style={style} className="flex w-full flex-col items-center gap-2">
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="group relative flex w-full justify-center" />}
        >
          {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
          {/* folder indicator is active when (collapsed and) one of its servers is selected */}
          <RailIndicator active={!open && items.some((s) => s.id === activeId)} />
          <button
            onClick={onToggle}
            {...attributes}
            {...listeners}
            className={[
              "grid size-10 cursor-pointer touch-none grid-cols-2 gap-0.5 p-1.5 transition-all duration-150 active:cursor-grabbing",
              open ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent hover:rounded-xl hover:bg-primary/20",
            ].join(" ")}
          >
            {items.map((s) => (
              <span key={s.id} className="grid place-items-center rounded-lg bg-card text-[7px] font-semibold text-muted-foreground">{s.initial}</span>
            ))}
          </button>
          <RailTooltip label="Workspaces" />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onClick={onUngroup}>Ungroup</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* expanded: member servers full-width (so their left bars align with the rail
          edge like other servers); the tinted pill background sits behind, centered */}
      {open && (
        <div className="relative flex w-full flex-col items-center gap-2 py-2">
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-12 -translate-x-1/2 rounded-[20px] bg-primary/10" />
          <DndContext id="d-folder" sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onInnerDragEnd}>
            <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              {items.map((s) => (
                <SortableFolderServer key={s.id} server={s} active={activeId === s.id} onClick={() => pick(s.id)} />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </div>
  )
}

// A draggable server inside an expanded folder.
function SortableFolderServer({ server, active, onClick }: { server: FolderServer; active: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: server.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <div ref={setNodeRef} style={style} className="group relative flex w-full justify-center">
      {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
      <RailIndicator active={active} />
      <button
        onClick={onClick}
        {...attributes}
        {...listeners}
        className={[
          "grid size-10 cursor-pointer touch-none place-items-center text-sm font-semibold transition-all duration-150 active:cursor-grabbing",
          active ? "rounded-xl bg-primary text-primary-foreground" : "rounded-[18px] bg-card hover:rounded-xl hover:bg-primary hover:text-primary-foreground",
        ].join(" ")}
      >
        {server.initial}
      </button>
      <RailTooltip label={server.name} />
    </div>
  )
}
