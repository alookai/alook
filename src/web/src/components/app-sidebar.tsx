"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import type { Agent } from "@alook/shared";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { Monitor, SunMoon, Plus, CalendarDays, GitBranch, Settings, PinIcon, PinOffIcon, ArrowLeftRight, Home, CircleDot } from "lucide-react";
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
import { parseAvatarUrl } from "@/components/avatar";
import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function AgentSidebarButton({
  agent,
  isActive,
  isPinned,
  isOnline,
  taskCount,
  onClick,
  onPin,
  onUnpin,
}: {
  agent: Agent;
  isActive: boolean;
  isPinned: boolean;
  isOnline: boolean;
  taskCount: number;
  onClick: () => void;
  onPin: () => void;
  onUnpin: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <Popover
      open={previewOpen}
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
              return <AnimatedAvatar config={avatarConfig} size={40} className="rounded-xl" isHovered={false} />;
            }
            return agent.name.charAt(0).toUpperCase();
          })()}
          <span className={cn(
            "absolute bottom-0 right-0 size-2 rounded-full ring-2 ring-background",
            isOnline ? "bg-status-online" : "bg-status-offline"
          )} />
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
        <AgentPreviewCard agent={agent} isOnline={isOnline} activeTaskCount={taskCount} />
      </PopoverContent>
    </Popover>
  );
}

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
  const { slug } = useWorkspace();

  const { resolvedTheme, setTheme } = useTheme();
  const { activeTaskCounts: taskCounts } = useAgentContext();

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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = pinned.findIndex((a) => a.id === active.id);
    const newIndex = pinned.findIndex((a) => a.id === over.id);
    const reordered = arrayMove(pinned, oldIndex, newIndex);
    handleReorderPins(reordered.map((a) => a.id));
  }

  function handleUnpinnedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = unpinned.findIndex((a) => a.id === active.id);
    const newIndex = unpinned.findIndex((a) => a.id === over.id);
    const reordered = arrayMove(unpinned, oldIndex, newIndex);
    handleReorderUnpinned(reordered.map((a) => a.id));
  }

  const prefix = `/w/${slug}`;
  const isHome = pathname === `${prefix}/home`;
  const isRuntimes = pathname === `${prefix}/runtimes`;
  const isCalendar = pathname === `${prefix}/calendar`;
  const isTraces = pathname.startsWith(`${prefix}/threads`);
  const isIssues = pathname.startsWith(`${prefix}/issues`);
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

  const renderAgentButton = (agent: typeof agents[number], animIndex: number) => (
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
        onPin={() => handlePinAgent(agent.id)}
        onUnpin={() => handleUnpinAgent(agent.id)}
      />
    </div>
  );

  return (
    <nav className={cn("flex h-full w-14 flex-col items-center pt-1 pb-2 gap-0.5", wiggling && "relative z-10")}>
      {/* Top — logo (easter egg: click to wake agents) */}
      <div className="pb-1.5 mb-1">
        <div
          className="flex shrink-0 items-center justify-center size-8 [&>button]:pointer-events-none cursor-pointer active:scale-90 transition-transform"
          onClick={triggerWiggle}
        >
          <Logo size="sm" iconOnly />
        </div>
      </div>

      {/* Home & Threads */}
      <div className="flex flex-col items-center gap-1.5 pb-1.5 border-b border-border/50 mb-1">
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

        <Tooltip>
          <TooltipTrigger render={
            <button
              type="button"
              onClick={() => { router.push(`${prefix}/threads`); onNavigate?.(); }}
              className={cn(
                "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                "text-muted-foreground hover:text-foreground hover:bg-accent",
                isTraces && "bg-accent text-foreground"
              )}
            />
          }>
            <GitBranch className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Threads</TooltipContent>
        </Tooltip>

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
      </div>

      {/* Agent avatars */}
      <div className={cn("flex flex-1 w-full flex-col items-center gap-1.5 py-1 scrollbar-none", wiggling ? "overflow-visible" : "overflow-y-auto")}>
        {loading ? (
          <Skeleton className="size-10 rounded-xl" />
        ) : (
          <>
            <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
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
            <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={handleUnpinnedDragEnd}>
              <SortableContext items={unpinned.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                {unpinned.map((agent, i) => (
                  <SortableAgentButton key={agent.id} id={agent.id}>
                    {renderAgentButton(agent, pinned.length + i)}
                  </SortableAgentButton>
                ))}
              </SortableContext>
            </DndContext>
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
