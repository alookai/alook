"use client";

import type { Agent } from "@alook/shared";
import type { AgentFolder } from "@/hooks/use-agent-folders";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FolderCollapsed } from "./folder-collapsed";

export function SortableFolderItem({
  folder,
  agents,
  isActive,
  isMergeTarget,
  dragActiveId,
  onExpand,
  nodeRefCallback,
}: {
  folder: AgentFolder;
  agents: Agent[];
  isActive: boolean;
  isMergeTarget: boolean;
  dragActiveId?: string | null;
  onExpand: () => void;
  nodeRefCallback?: (el: HTMLElement | null) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: folder.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        nodeRefCallback?.(el);
      }}
      style={style}
      {...attributes}
      {...listeners}
      className="transition-all duration-200"
    >
      <FolderCollapsed
        folder={isMergeTarget && dragActiveId
          ? { ...folder, agentIds: [...folder.agentIds, dragActiveId] }
          : folder}
        agents={agents}
        isActive={isActive}
        onClick={onExpand}
      />
    </div>
  );
}
