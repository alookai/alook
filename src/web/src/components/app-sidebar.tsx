"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import type { Agent } from "@alook/shared";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { Monitor, SunMoon, Plus, LayoutGrid, CalendarDays, Settings, PinIcon, PinOffIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useTheme } from "next-themes";
import { NavUser } from "@/components/nav-user";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";

function AgentSidebarButton({
  agent,
  isActive,
  isPinned,
  taskCount,
  onClick,
  onPin,
  onUnpin,
}: {
  agent: Agent;
  isActive: boolean;
  isPinned: boolean;
  taskCount: number;
  onClick: () => void;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "transition-shadow duration-150",
        isDragging && "opacity-50 z-50"
      )}
    >
      <Popover
        open={previewOpen && !isDragging}
        onOpenChange={(open, event) => {
          if (open && event.reason === "trigger-press") return;
          setPreviewOpen(open);
        }}
      >
        <ContextMenu>
          <PopoverTrigger
            openOnHover
            delay={10}
            render={
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    onClick={() => { setPreviewOpen(false); onClick(); }}
                    className={cn(
                      "relative flex shrink-0 items-center justify-center size-10 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer",
                      isActive
                        ? "ring-2 ring-primary shadow-sm"
                        : "ring-0 bg-secondary text-secondary-foreground hover:bg-accent"
                    )}
                  />
                }
              />
            }
          >
            {(() => {
              const avatarConfig = parseAvatarUrl(agent.avatar_url);
              if (avatarConfig) {
                return <AvatarRenderer config={avatarConfig} size={40} className="rounded-xl" />;
              }
              return agent.name.charAt(0).toUpperCase();
            })()}
            {taskCount > 0 && (
              <span className="absolute bottom-0 right-0 size-2 rounded-full bg-status-online animate-pulse ring-2 ring-background" />
            )}
          </PopoverTrigger>
          <ContextMenuContent>
            {isPinned ? (
              <ContextMenuItem onClick={onUnpin}>
                <PinOffIcon className="size-3.5 mr-1.5" />
                Unpin
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onClick={onPin}>
                <PinIcon className="size-3.5 mr-1.5" />
                Pin to top
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
        <PopoverContent side="right" className="w-fit max-w-80">
          <AgentPreviewCard agent={agent} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function AppSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { agents, runtimes, loading, pins, handlePinAgent, handleUnpinAgent, handleReorderPins } = useAgentContext();
  const { slug } = useWorkspace();

  const { resolvedTheme, setTheme } = useTheme();
  const { activeTaskCounts: taskCounts } = useAgentContext();

  const isPinned = useCallback((agentId: string) => {
    const entry = pins.get(agentId);
    return entry?.pinned === true;
  }, [pins]);

  const { pinnedAgents, unpinnedAgents, pinnedIds, unpinnedIds } = useMemo(() => {
    const pinned = agents
      .filter((a) => isPinned(a.id))
      .sort((a, b) => (pins.get(a.id)?.order ?? 0) - (pins.get(b.id)?.order ?? 0));
    const unpinned = agents
      .filter((a) => !isPinned(a.id));
    // Sort unpinned: those with stored order first (by order), then alphabetical
    const withOrder = unpinned.filter(a => pins.has(a.id)).sort((a, b) => (pins.get(a.id)?.order ?? 0) - (pins.get(b.id)?.order ?? 0));
    const withoutOrder = unpinned.filter(a => !pins.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
    const sortedUnpinned = [...withOrder, ...withoutOrder];
    return {
      pinnedAgents: pinned,
      unpinnedAgents: sortedUnpinned,
      pinnedIds: pinned.map(a => a.id),
      unpinnedIds: sortedUnpinned.map(a => a.id),
    };
  }, [agents, pins, isPinned]);

  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const unpinnedIdSet = useMemo(() => new Set(unpinnedIds), [unpinnedIds]);

  const [isDragging, setIsDragging] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    setIsDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    // Block cross-zone drag
    const activeInPinned = pinnedIdSet.has(activeId);
    const overInPinned = pinnedIdSet.has(overId);
    if (activeInPinned !== overInPinned) return;
    if (activeInPinned) {
      const oldIndex = pinnedIds.indexOf(activeId);
      const newIndex = pinnedIds.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return;
      handleReorderPins(arrayMove(pinnedIds, oldIndex, newIndex), unpinnedIds);
    } else {
      const oldIndex = unpinnedIds.indexOf(activeId);
      const newIndex = unpinnedIds.indexOf(overId);
      if (oldIndex === -1 || newIndex === -1) return;
      handleReorderPins(pinnedIds, arrayMove(unpinnedIds, oldIndex, newIndex));
    }
  };

  const prefix = `/w/${slug}`;
  const isHome = pathname === `${prefix}/home`;
  const isRuntimes = pathname === `${prefix}/runtimes`;
  const isCalendar = pathname === `${prefix}/calendar`;
  const isSettings = pathname === `${prefix}/settings`;
  const isCreateAgent = pathname === `${prefix}/agents/new`;

  // Detect active agent from ?agent= param or /w/[slug]/agents/[id] route
  const urlAgentId = searchParams.get("agent");
  const pathnameAgentMatch = pathname.match(/^\/w\/[^/]+\/agents\/([^/]+)/);
  const activeAgentId = urlAgentId ?? pathnameAgentMatch?.[1] ?? null;

  const handleAgentClick = (agentId: string) => {
    router.push(`${prefix}/agents/${agentId}`);
    onNavigate?.();
  };

  return (
    <nav className="flex h-full w-14 flex-col items-center pt-1 pb-2 gap-0.5">
      {/* Top — logo as Home link */}
      <div className="pb-1.5 border-b border-border/50 mb-1">
        <div
          className="flex shrink-0 items-center justify-center size-8 cursor-pointer [&>button]:pointer-events-none"
          onClick={() => { router.push(`${prefix}/home`); onNavigate?.(); }}
        >
          <Logo size="sm" iconOnly />
        </div>
      </div>

      {/* Agent avatars */}
      <div className="flex flex-1 w-full flex-col items-center gap-1.5 overflow-y-auto py-1 scrollbar-none">
        {loading ? (
          <Skeleton className="size-10 rounded-xl" />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={() => setIsDragging(true)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setIsDragging(false)}
          >
            <SortableContext items={pinnedIds} strategy={verticalListSortingStrategy}>
              {pinnedAgents.map((agent) => (
                <AgentSidebarButton
                  key={agent.id}
                  agent={agent}
                  isActive={activeAgentId === agent.id}
                  isPinned
                  taskCount={taskCounts[agent.id] ?? 0}
                  onClick={() => handleAgentClick(agent.id)}
                  onPin={() => handlePinAgent(agent.id)}
                  onUnpin={() => handleUnpinAgent(agent.id)}
                />
              ))}
            </SortableContext>
            {pinnedAgents.length > 0 && unpinnedAgents.length > 0 && (
              <div className={cn(
                "border-t transition-all duration-200",
                isDragging
                  ? "w-10 border-t-2 border-primary/60"
                  : "w-6 border-border/50"
              )} />
            )}
            <SortableContext items={unpinnedIds} strategy={verticalListSortingStrategy}>
              {unpinnedAgents.map((agent) => (
                <AgentSidebarButton
                  key={agent.id}
                  agent={agent}
                  isActive={activeAgentId === agent.id}
                  isPinned={false}
                  taskCount={taskCounts[agent.id] ?? 0}
                  onClick={() => handleAgentClick(agent.id)}
                  onPin={() => handlePinAgent(agent.id)}
                  onUnpin={() => handleUnpinAgent(agent.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
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
          <button
            type="button"
            title="New agent"
            onClick={() => { router.push(`${prefix}/agents/new`); onNavigate?.(); }}
            className={cn(
              "flex shrink-0 items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
              "border border-dashed border-foreground/15 text-muted-foreground",
              "hover:border-foreground/30 hover:text-foreground hover:bg-accent",
              isCreateAgent &&
                "border-solid border-foreground/25 bg-accent text-foreground"
            )}
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>

      {/* Bottom section */}
      <div className="flex flex-col items-center gap-1 pt-2 border-t border-border/50 mt-1">
        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push("/workspaces"); onNavigate?.(); }}
              className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
            />
          }>
            <LayoutGrid className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Workspaces</TooltipContent>
        </Tooltip>

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
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
            />
          }>
            <SunMoon className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Toggle theme</TooltipContent>
        </Tooltip>

        <NavUser />
      </div>
    </nav>
  );
}
