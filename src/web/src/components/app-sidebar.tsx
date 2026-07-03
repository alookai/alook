"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import type { Agent } from "@alook/shared";
import { InboxPopover } from "@/components/inbox-popover";
import { FlagPopover } from "@/components/flag-popover";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { Monitor, SunMoon, Plus, CalendarDays, Settings, ArrowLeftRight, Home, CircleDot, Folder, Ungroup, ArrowRightToLine } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTheme } from "next-themes";
import { NavUser } from "@/components/nav-user";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { parseAvatarUrl } from "@/components/avatar";
import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, DragOverlay, type DragEndEvent, type DragStartEvent, type DragOverEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAgentFolders } from "@/hooks/use-agent-folders";
import { AgentSidebarButton } from "@/components/sidebar/agent-sidebar-button";
import { SortableFolderItem } from "@/components/sidebar/sortable-folder-item";
import { FolderCollapsed } from "@/components/sidebar/folder-collapsed";
import { FolderPopover } from "@/components/sidebar/folder-popover";

function SortableAgentButton({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
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

export function AppSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { agents, runtimes, loading, pins, unpinnedOrder, handlePinAgent, handleUnpinAgent, handleReorderPins, handleReorderUnpinned } = useAgentContext();
  const { slug, workspaceId } = useWorkspace();

  const { resolvedTheme, setTheme } = useTheme();
  const { activeTaskCounts: taskCounts } = useAgentContext();

  // --- Folder state (applies to unpinned section only) ---
  const {
    folders,
    expandedFolderId,
    setExpandedFolderId,
    createFolder,
    addToFolder,
    removeFromFolder,
    dissolveFolder,
    reorderInFolder,
    cleanupStaleAgents,
    getTopLevelItems,
    removeAgentFromAnyFolder,
    mergeFolders,
  } = useAgentFolders(workspaceId);

  // --- Selection mode for "Create group" ---
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());

  const pinned = agents
    .filter((a) => pins.has(a.id))
    .sort((a, b) => pins.get(a.id)!.position - pins.get(b.id)!.position);
  const unpinned = agents
    .filter((a) => !pins.has(a.id))
    .sort((a, b) => {
      const posA = unpinnedOrder.get(a.id);
      const posB = unpinnedOrder.get(b.id);
      if (posA !== undefined && posB !== undefined) return posA - posB;
      if (posA !== undefined) return -1;
      if (posB !== undefined) return 1;
      return a.name.localeCompare(b.name);
    });

  // Folders apply to the unpinned section
  const unpinnedIds = unpinned.map((a) => a.id);
  const topLevelUnpinnedItems = getTopLevelItems(unpinnedIds);

  // Cleanup stale agents when workspace agents change
  useEffect(() => {
    if (agents.length > 0) {
      cleanupStaleAgents(agents.map((a) => a.id));
    }
  }, [agents, cleanupStaleAgents]);

  // --- Drag-hold merge state (unpinned section) ---
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [sortingDisabled, setSortingDisabled] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const hoverTargetRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  // --- Folder anchor refs for popover positioning ---
  const folderAnchorRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  // Build sortable IDs for unpinned: mix of agent IDs and folder IDs
  const unpinnedSortableIds = topLevelUnpinnedItems.map((item) =>
    item.type === "agent" ? item.id : item.folder.id
  );

  // --- Pinned section drag (unchanged, simple reorder) ---
  function handlePinnedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = pinned.findIndex((a) => a.id === active.id);
    const newIndex = pinned.findIndex((a) => a.id === over.id);
    const reordered = arrayMove(pinned, oldIndex, newIndex);
    handleReorderPins(reordered.map((a) => a.id));
  }

  // --- Unpinned section drag (with folder merge support) ---
  function handleUnpinnedDragStart(event: DragStartEvent) {
    setDragActiveId(event.active.id as string);
    setExpandedFolderId(null);
  }

  function handleUnpinnedDragOver(event: DragOverEvent) {
    const { over } = event;
    if (!over) {
      clearMergeTimer();
      return;
    }

    const overId = over.id as string;
    if (overId === dragActiveId) {
      clearMergeTimer();
      return;
    }

    if (hoverTargetRef.current !== overId) {
      clearMergeTimer();
      hoverTargetRef.current = overId;
      hoverTimerRef.current = setTimeout(() => {
        setSortingDisabled(true);
        setMergeTargetId(overId);
      }, 300);
    }
  }

  function clearMergeTimer() {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverTargetRef.current = null;
    setMergeTargetId(null);
    setSortingDisabled(false);
  }

  function handleUnpinnedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    clearMergeTimer();
    setDragActiveId(null);

    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (mergeTargetId === overId) {
      handleMerge(activeId, overId);
      setMergeTargetId(null);
      return;
    }

    const oldIndex = unpinnedSortableIds.indexOf(activeId);
    const newIndex = unpinnedSortableIds.indexOf(overId);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(topLevelUnpinnedItems, oldIndex, newIndex);
    const flatIds: string[] = [];
    for (const item of reordered) {
      if (item.type === "agent") {
        flatIds.push(item.id);
      } else {
        flatIds.push(...item.folder.agentIds);
      }
    }
    handleReorderUnpinned(flatIds);
  }

  function handleUnpinnedDragCancel() {
    clearMergeTimer();
    setDragActiveId(null);
  }

  function handleMerge(draggedId: string, targetId: string) {
    const targetFolder = folders.find((f) => f.id === targetId);
    if (targetFolder) {
      const draggedFolder = folders.find((f) => f.id === draggedId);
      if (draggedFolder) {
        mergeFolders(draggedId, targetId);
      } else {
        removeAgentFromAnyFolder(draggedId);
        addToFolder(targetId, draggedId);
      }
    } else {
      const draggedFolder = folders.find((f) => f.id === draggedId);
      if (draggedFolder) {
        addToFolder(draggedId, targetId);
      } else {
        createFolder([targetId, draggedId]);
      }
    }
  }

  // Wrapped pin handler: removes agent from folder before pinning
  const handlePinWithFolderCleanup = useCallback(
    (agentId: string) => {
      removeAgentFromAnyFolder(agentId);
      handlePinAgent(agentId);
    },
    [removeAgentFromAnyFolder, handlePinAgent]
  );

  const prefix = `/w/${slug}`;
  const isHome = pathname === `${prefix}/home`;
  const isRuntimes = pathname === `${prefix}/runtimes`;
  const isCalendar = pathname === `${prefix}/calendar`;
  const isInbox = pathname.startsWith(`${prefix}/unread`);
  const isFlags = pathname.startsWith(`${prefix}/flags`);
  const isIssues = pathname.startsWith(`${prefix}/issues`);
  const isSettings = pathname === `${prefix}/settings`;
  const isCreateAgent = pathname === `${prefix}/agents/new`;

  const urlAgentId = searchParams.get("agent");
  const pathnameAgentMatch = pathname.match(/^\/w\/[^/]+\/agents\/([^/]+)/);
  const activeAgentId = urlAgentId ?? pathnameAgentMatch?.[1] ?? null;

  const handleAgentClick = (agentId: string) => {
    router.push(`${prefix}/agents/${agentId}`);
    onNavigate?.();
  };

  const hasOnlineRuntime = runtimes.some((r) => r.status === "online");

  const [wiggling, setWiggling] = useState(false);
  const wiggleRef = useRef(false);
  const wiggleTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => {
      if (wiggleTimerRef.current) clearTimeout(wiggleTimerRef.current);
    };
  }, []);

  const triggerWiggle = useCallback(() => {
    if (wiggleRef.current) return;
    wiggleRef.current = true;
    setWiggling(true);
    const count = pinned.length + unpinned.length;
    const total = Math.max(0, count - 1) * 60 + 250;
    wiggleTimerRef.current = setTimeout(() => {
      wiggleRef.current = false;
      setWiggling(false);
    }, total);
  }, [pinned.length, unpinned.length]);

  // Get the drag overlay content for the unpinned section
  const dragActiveAgent = dragActiveId
    ? agents.find((a) => a.id === dragActiveId)
    : null;
  const dragActiveFolder = dragActiveId
    ? folders.find((f) => f.id === dragActiveId)
    : null;

  const renderAgentButton = (agent: typeof agents[number], animIndex: number, extraContextMenuItems?: React.ReactNode) => (
    <div
      className={cn(wiggling && "sidebar-agent-pop")}
      style={wiggling ? { animationDelay: `${animIndex * 60}ms` } : undefined}
    >
      <AgentSidebarButton
        agent={agent}
        isActive={activeAgentId === agent.id}
        isPinned={pins.has(agent.id)}
        isOnline={hasOnlineRuntime}
        taskCount={taskCounts[agent.id] ?? 0}
        onClick={() => handleAgentClick(agent.id)}
        onPin={() => handlePinWithFolderCleanup(agent.id)}
        onUnpin={() => handleUnpinAgent(agent.id)}
        extraContextMenuItems={extraContextMenuItems}
        isDragActive={!!dragActiveId}
      />
    </div>
  );

  // Build folder-related context menu items for a standalone unpinned agent
  const buildUnpinnedAgentContextMenu = (agentId: string) => (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => {
          setSelectedAgentIds(new Set([agentId]));
          setSelectionMode(true);
        }}
      >
        <Folder className="size-3.5 mr-2" />
        Create group
      </ContextMenuItem>
      {folders.length > 0 && (
        <>
          {folders.map((f) => {
            const folderAgents = f.agentIds
              .map((id) => agents.find((a) => a.id === id))
              .filter(Boolean) as Agent[];
            const label = folderAgents
              .slice(0, 2)
              .map((a) => a.name)
              .join(", ");
            return (
              <ContextMenuItem
                key={f.id}
                onClick={() => addToFolder(f.id, agentId)}
              >
                <ArrowRightToLine className="size-3.5 mr-2" />
                Move to {label}{folderAgents.length > 2 ? "…" : ""}
              </ContextMenuItem>
            );
          })}
        </>
      )}
    </>
  );

  const handleSelectionConfirm = () => {
    if (selectedAgentIds.size >= 2) {
      createFolder(Array.from(selectedAgentIds));
    }
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
  };

  const handleSelectionCancel = () => {
    setSelectionMode(false);
    setSelectedAgentIds(new Set());
  };

  const toggleAgentSelection = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const closeFolderPopover = useCallback(() => setExpandedFolderId(null), [setExpandedFolderId]);

  const expandedFolder = expandedFolderId
    ? folders.find((f) => f.id === expandedFolderId) ?? null
    : null;

  return (
    <nav className={cn("flex h-full w-14 flex-col items-center pt-1 pb-2 gap-1", wiggling && "relative z-10")}>
      {/* Top — logo */}
      <div className="pb-1.5 mb-1">
        <div
          className="flex shrink-0 items-center justify-center size-8 [&>button]:pointer-events-none cursor-pointer active:scale-90 transition-transform"
          onClick={triggerWiggle}
        >
          <Logo size="sm" iconOnly />
        </div>
      </div>

      {/* Main navigation */}
      <div className="flex flex-col items-center gap-2 pb-1.5 border-b border-border/50 mb-1">
        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push(`${prefix}/home`); onNavigate?.(); }}
              className={cn(
                "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                isHome && "bg-accent text-foreground"
              )}
            />
          }>
            <Home className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Home</TooltipContent>
        </Tooltip>

        <InboxPopover isActive={isInbox} onNavigate={onNavigate} />

        <FlagPopover isActive={isFlags} onNavigate={onNavigate} />

        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push(`${prefix}/issues`); onNavigate?.(); }}
              className={cn(
                "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                isIssues && "bg-accent text-foreground"
              )}
            />
          }>
            <CircleDot className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Issues</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push(`${prefix}/calendar`); onNavigate?.(); }}
              className={cn(
                "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                isCalendar && "bg-accent text-foreground"
              )}
            />
          }>
            <CalendarDays className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Calendar</TooltipContent>
        </Tooltip>

      </div>

      {/* Agent avatars */}
      <div className={cn("flex flex-1 w-full flex-col items-center gap-2 py-1 scrollbar-none", wiggling ? "overflow-visible" : "overflow-y-auto")}>
        {loading ? (
          <Skeleton className="size-10 rounded-xl" />
        ) : (
          <>
            {/* Pinned section (flat, no folders) */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={handlePinnedDragEnd}>
              <SortableContext items={pinned.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                {pinned.map((agent, i) => (
                  <SortableAgentButton key={agent.id} id={agent.id}>
                    {renderAgentButton(agent, i)}
                  </SortableAgentButton>
                ))}
              </SortableContext>
            </DndContext>

            {pinned.length > 0 && unpinned.length > 0 && (
              <div className="w-6 border-t border-border/50" />
            )}

            {/* Unpinned section with folders */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragStart={handleUnpinnedDragStart}
              onDragOver={handleUnpinnedDragOver}
              onDragEnd={handleUnpinnedDragEnd}
              onDragCancel={handleUnpinnedDragCancel}
            >
              <SortableContext items={unpinnedSortableIds} strategy={sortingDisabled ? undefined : verticalListSortingStrategy}>
                {topLevelUnpinnedItems.map((item, i) => {
                  if (item.type === "folder") {
                    const folder = item.folder;
                    const isAnyActive = folder.agentIds.includes(activeAgentId ?? "");
                    return (
                      <ContextMenu key={folder.id}>
                        <ContextMenuTrigger render={<div />}>
                          <SortableFolderItem
                            folder={folder}
                            agents={agents}
                            isActive={isAnyActive}
                            isMergeTarget={mergeTargetId === folder.id}
                            dragActiveId={dragActiveId}
                            onExpand={() =>
                              setExpandedFolderId(
                                expandedFolderId === folder.id ? null : folder.id
                              )
                            }
                            nodeRefCallback={(el) =>
                              folderAnchorRefs.current.set(folder.id, el)
                            }
                          />
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem onClick={() => dissolveFolder(folder.id)}>
                            <Ungroup className="size-3.5 mr-2" />
                            Ungroup agents
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  }

                  // Standalone unpinned agent in selection mode
                  if (selectionMode) {
                    const agent = agents.find((a) => a.id === item.id);
                    if (!agent) return null;
                    const isSelected = selectedAgentIds.has(agent.id);
                    return (
                      <div
                        key={agent.id}
                        className="relative cursor-pointer"
                        onClick={() => toggleAgentSelection(agent.id)}
                      >
                        <div className={cn(
                          "transition-all duration-150",
                          isSelected && "ring-2 ring-primary/50 rounded-xl"
                        )}>
                          {renderAgentButton(agent, pinned.length + i)}
                        </div>
                        {isSelected && (
                          <span className="absolute -top-1 -right-1 size-3 rounded-full bg-primary ring-2 ring-background" />
                        )}
                      </div>
                    );
                  }

                  // Standalone unpinned agent (normal mode)
                  const agent = agents.find((a) => a.id === item.id);
                  if (!agent) return null;
                  return (
                    <SortableAgentButton key={agent.id} id={agent.id}>
                      {mergeTargetId === agent.id && dragActiveId ? (
                        <FolderCollapsed
                          folder={{ id: "merge-preview", agentIds: [agent.id, dragActiveId] }}
                          agents={agents}
                          isActive={false}
                          onClick={() => {}}
                        />
                      ) : (
                        renderAgentButton(agent, pinned.length + i, buildUnpinnedAgentContextMenu(agent.id))
                      )}
                    </SortableAgentButton>
                  );
                })}
              </SortableContext>

              <DragOverlay>
                {dragActiveAgent ? (
                  <div className="opacity-80">
                    {(() => {
                      const avatarConfig = parseAvatarUrl(dragActiveAgent.avatar_url);
                      if (avatarConfig) {
                        return <AnimatedAvatar config={avatarConfig} size={40} className="rounded-xl" isHovered={false} />;
                      }
                      return (
                        <div className="flex items-center justify-center size-10 rounded-xl bg-secondary text-sm font-medium">
                          {dragActiveAgent.name.charAt(0).toUpperCase()}
                        </div>
                      );
                    })()}
                  </div>
                ) : dragActiveFolder ? (
                  <div className="opacity-80">
                    <FolderCollapsed
                      folder={dragActiveFolder}
                      agents={agents}
                      isActive={false}
                      onClick={() => {}}
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>

            {/* Selection mode confirmation bar */}
            {selectionMode && (
              <div className="flex flex-col gap-1 w-full px-1">
                <button
                  type="button"
                  onClick={handleSelectionConfirm}
                  disabled={selectedAgentIds.size < 2}
                  className="flex items-center justify-center h-7 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  Done ({selectedAgentIds.size})
                </button>
                <button
                  type="button"
                  onClick={handleSelectionCancel}
                  className="flex items-center justify-center h-7 rounded-lg bg-secondary text-secondary-foreground text-xs cursor-pointer hover:bg-accent"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}

        {/* Create agent */}
        {!loading && agents.length === 0 && runtimes.some(r => r.status === "online") ? (
          <Tooltip open>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => { router.push(`${prefix}/agents/new`); onNavigate?.(); }}
                  className={cn(
                    "relative flex shrink-0 items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                    "border border-dashed border-primary/50 text-primary",
                    "hover:border-primary hover:bg-primary/10",
                    "animate-pulse",
                    isCreateAgent && "border-solid border-primary bg-primary/10 animate-none"
                  )}
                />
              }
            >
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Create your first agent
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => { router.push(`${prefix}/agents/new`); onNavigate?.(); }}
                  className={cn(
                    "flex shrink-0 items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                    "border border-dashed border-foreground/15 text-muted-foreground",
                    "hover:border-foreground/30 hover:text-foreground hover:bg-accent",
                    isCreateAgent &&
                      "border-solid border-foreground/25 bg-accent text-foreground"
                  )}
                />
              }
            >
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipContent>New agent</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Folder popover */}
      {expandedFolder && (
        <FolderPopover
          folder={expandedFolder}
          agents={agents}
          activeAgentId={activeAgentId}
          isOnline={hasOnlineRuntime}
          taskCounts={taskCounts}
          // eslint-disable-next-line react-hooks/refs -- stable DOM ref read, useEffect would cause anchor flash
          anchorRef={folderAnchorRefs.current.get(expandedFolder.id) ?? null}
          onAgentClick={handleAgentClick}
          onRemoveFromFolder={(agentId) =>
            removeFromFolder(expandedFolder.id, agentId)
          }
          onPinAgent={handlePinWithFolderCleanup}
          onReorder={(ordered) =>
            reorderInFolder(expandedFolder.id, ordered)
          }
          onClose={closeFolderPopover}
        />
      )}

      {/* Bottom section */}
      <div className="flex flex-col items-center gap-1 pt-2 border-t border-border/50 mt-1">
        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push(`${prefix}/runtimes`); onNavigate?.(); }}
              className={cn(
                "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                isRuntimes && "bg-accent text-foreground"
              )}
            />
          }>
            <Monitor className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Runtimes</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
            />
          }>
            <SunMoon className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Toggle theme</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push(`${prefix}/settings`); onNavigate?.(); }}
              className={cn(
                "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                isSettings && "bg-accent text-foreground"
              )}
            />
          }>
            <Settings className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push("/workspaces"); onNavigate?.(); }}
              className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
            />
          }>
            <ArrowLeftRight className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Switch workspace</TooltipContent>
        </Tooltip>

        <NavUser />
      </div>
    </nav>
  );
}
