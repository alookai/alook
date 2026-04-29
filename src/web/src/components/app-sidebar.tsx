"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
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

export function AppSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { agents, runtimes, loading, pins, handlePinAgent, handleUnpinAgent } = useAgentContext();
  const { slug } = useWorkspace();

  const { resolvedTheme, setTheme } = useTheme();
  const { activeTaskCounts: taskCounts } = useAgentContext();

  const pinned = agents
    .filter((a) => pins.has(a.id))
    .sort((a, b) => (pins.get(a.id)! < pins.get(b.id)! ? -1 : 1));
  const unpinned = agents
    .filter((a) => !pins.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));

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

  const renderAgentButton = (agent: typeof agents[number]) => {
    const isActive = activeAgentId === agent.id;
    const isPinned = pins.has(agent.id);
    return (
      <Tooltip key={agent.id}>
        <ContextMenu>
          <TooltipTrigger
            render={
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    onClick={() => handleAgentClick(agent.id)}
                    className={cn(
                      "relative flex shrink-0 items-center justify-center size-10 rounded-xl text-sm font-medium transition-colors duration-200 cursor-pointer",
                      isActive
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "bg-secondary text-secondary-foreground hover:bg-accent"
                    )}
                  />
                }
              />
            }
          >
            {agent.name.charAt(0).toUpperCase()}
            {(taskCounts[agent.id] ?? 0) > 0 && (
              <span className="absolute bottom-0 right-0 size-2 rounded-full bg-status-online animate-pulse ring-2 ring-background" />
            )}
          </TooltipTrigger>
          <ContextMenuContent>
            {isPinned ? (
              <ContextMenuItem onClick={() => handleUnpinAgent(agent.id)}>
                <PinOffIcon className="size-3.5 mr-1.5" />
                Unpin
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onClick={() => handlePinAgent(agent.id)}>
                <PinIcon className="size-3.5 mr-1.5" />
                Pin to top
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        </ContextMenu>
        <TooltipContent side="right">{agent.name} (right-click for options)</TooltipContent>
      </Tooltip>
    );
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
          <>
            {pinned.map(renderAgentButton)}
            {pinned.length > 0 && unpinned.length > 0 && (
              <div className="w-6 border-t border-border/50" />
            )}
            {unpinned.map(renderAgentButton)}
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
