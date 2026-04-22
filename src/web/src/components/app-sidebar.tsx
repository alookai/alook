"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { Monitor, SunMoon, Plus, LayoutGrid, CalendarDays, Settings, PinIcon, PinOffIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
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
  const { agents, loading, pins, handlePinAgent, handleUnpinAgent } = useAgentContext();
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
      <ContextMenu key={agent.id}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              title={agent.name}
              onClick={() => handleAgentClick(agent.id)}
              className={cn(
                "relative flex shrink-0 items-center justify-center size-10 rounded-xl text-sm font-medium transition-colors duration-200 cursor-pointer",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-secondary text-secondary-foreground hover:bg-accent"
              )}
            />
          }
        >
          {agent.name.charAt(0).toUpperCase()}
          {(taskCounts[agent.id] ?? 0) > 0 && (
            <span className="absolute bottom-0 right-0 size-2 rounded-full bg-status-online animate-pulse ring-2 ring-background" />
          )}
        </ContextMenuTrigger>
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
    );
  };

  return (
    <nav className="flex h-full w-14 flex-col items-center py-2 gap-0.5">
      {/* Top — logo */}
      <div className="pb-2 border-b border-border/50 mb-1">
        <div className="flex shrink-0 items-center justify-center size-10">
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
      </div>

      {/* Bottom section */}
      <div className="flex flex-col items-center gap-1 pt-2 border-t border-border/50 mt-1">
        <button
          type="button"
          title="Workspaces"
          onClick={() => { router.push("/workspaces"); onNavigate?.(); }}
          className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
        >
          <LayoutGrid className="size-4" />
        </button>

        <button
          type="button"
          title="Runtimes"
          onClick={() => { router.push(`${prefix}/runtimes`); onNavigate?.(); }}
          className={cn(
            "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            isRuntimes && "bg-accent text-foreground"
          )}
        >
          <Monitor className="size-4" />
        </button>

        <button
          type="button"
          title="Calendar"
          onClick={() => { router.push(`${prefix}/calendar`); onNavigate?.(); }}
          className={cn(
            "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            isCalendar && "bg-accent text-foreground"
          )}
        >
          <CalendarDays className="size-4" />
        </button>

        <button
          type="button"
          title="Settings"
          onClick={() => { router.push(`${prefix}/settings`); onNavigate?.(); }}
          className={cn(
            "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            isSettings && "bg-accent text-foreground"
          )}
        >
          <Settings className="size-4" />
        </button>

        <button
          type="button"
          title="Toggle theme"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
        >
          <SunMoon className="size-4" />
        </button>

        <NavUser />
      </div>
    </nav>
  );
}
