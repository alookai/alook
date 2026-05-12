"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Agent } from "@alook/shared";
import type { AgentFolder } from "@/hooks/use-agent-folders";
import { AgentSidebarButton } from "./agent-sidebar-button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { PinOffIcon } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function SortablePopoverAgent({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

export function FolderPopover({
  folder,
  agents,
  activeAgentId,
  isOnline,
  taskCounts,
  anchorRef,
  onAgentClick,
  onRemoveFromFolder,
  onPinAgent,
  onReorder,
  onClose,
}: {
  folder: AgentFolder;
  agents: Agent[];
  activeAgentId: string | null;
  isOnline: boolean;
  taskCounts: Record<string, number>;
  anchorRef: HTMLElement | null;
  onAgentClick: (agentId: string) => void;
  onRemoveFromFolder: (agentId: string) => void;
  onPinAgent: (agentId: string) => void;
  onReorder: (orderedAgentIds: string[]) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const updatePosition = useCallback(() => {
    if (!anchorRef) return;
    const rect = anchorRef.getBoundingClientRect();
    setPosition({ left: rect.right + 8, top: rect.top });
  }, [anchorRef]);

  useEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        anchorRef &&
        !anchorRef.contains(target) &&
        !(target as HTMLElement).closest?.('[data-slot="context-menu-content"]')
      ) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const scrollParent = anchorRef?.closest("[class*='overflow']") ?? window;
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", updatePosition);
    scrollParent.addEventListener("scroll", updatePosition, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", updatePosition);
      scrollParent.removeEventListener("scroll", updatePosition);
    };
  }, [anchorRef, onClose, updatePosition]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const folderAgents = folder.agentIds
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[];

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = folder.agentIds.indexOf(active.id as string);
    const newIndex = folder.agentIds.indexOf(over.id as string);
    onReorder(arrayMove(folder.agentIds, oldIndex, newIndex));
  }

  if (!anchorRef || !position) return null;

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 bg-popover border rounded-xl shadow-md p-1.5 animate-in fade-in-0 zoom-in-95"
      style={{
        left: position.left,
        top: position.top,
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={folder.agentIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col gap-1">
            {folderAgents.map((agent) => (
              <SortablePopoverAgent key={agent.id} id={agent.id}>
                <AgentSidebarButton
                  agent={agent}
                  isActive={activeAgentId === agent.id}
                  isPinned={false}
                  isOnline={isOnline}
                  taskCount={taskCounts[agent.id] ?? 0}
                  hidePin
                  onClick={() => {
                    onAgentClick(agent.id);
                    onClose();
                  }}
                  onPin={() => {
                    onPinAgent(agent.id);
                    onClose();
                  }}
                  onUnpin={() => {}}
                  extraContextMenuItems={
                    <ContextMenuItem
                      onClick={() => onRemoveFromFolder(agent.id)}
                    >
                      <PinOffIcon className="size-3.5 mr-1.5" />
                      Remove from group
                    </ContextMenuItem>
                  }
                />
              </SortablePopoverAgent>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
