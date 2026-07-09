"use client";

import { useRouter, usePathname } from "next/navigation";
import { CalendarDays, CircleDot, Home } from "lucide-react";
import { useSidebarTrigger } from "@/components/workspace-shell";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { AnimatedAvatar, parseAvatarUrl } from "@/components/avatar";
import { Logo } from "@/components/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function MobileTopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const openSidebar = useSidebarTrigger();
  const { slug } = useWorkspace();
  const { agents, pins, unpinnedOrder, runtimes, loading } = useAgentContext();

  const isHomeActive = pathname === `/w/${slug}/home`;
  const isCalendarActive = pathname.includes("/calendar");
  const isIssuesActive = pathname.includes("/issues");
  const activeAgentMatch = pathname.match(/^\/w\/[^/]+\/agents\/([^/]+)/);
  const activeAgentId = activeAgentMatch?.[1] ?? null;

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

  const ordered = [...pinned, ...unpinned];

  return (
    <div className="h-10 flex items-center gap-2 px-2 shrink-0">
      {openSidebar && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Open sidebar"
          onClick={openSidebar}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openSidebar();
            }
          }}
          className="shrink-0 cursor-pointer transition-opacity hover:opacity-70 [&>button]:pointer-events-none"
        >
          <Logo size="sm" iconOnly />
        </div>
      )}

      <button
        onClick={() => router.push(`/w/${slug}/home`)}
        aria-label="Home"
        className={cn(
          "shrink-0 p-1 rounded-md transition-colors",
          isHomeActive
            ? "text-foreground bg-muted"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Home className="size-4" />
      </button>

      <button
        onClick={() => router.push(`/w/${slug}/calendar`)}
        aria-label="Calendar"
        className={cn(
          "shrink-0 p-1 rounded-md transition-colors",
          isCalendarActive
            ? "text-foreground bg-muted"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <CalendarDays className="size-4" />
      </button>

      <button
        onClick={() => router.push(`/w/${slug}/issues`)}
        aria-label="Issues"
        className={cn(
          "shrink-0 p-1 rounded-md transition-colors",
          isIssuesActive
            ? "text-foreground bg-muted"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <CircleDot className="size-4" />
      </button>

      <div className="flex-1 overflow-x-auto flex items-center gap-2 py-1 px-1 scrollbar-none">
        {loading ? (
          <Skeleton className="size-7 rounded-full" />
        ) : (
          ordered.map((agent) => {
            const runtime = runtimes.find((r) => r.id === agent.runtime_id);
            const isOnline = runtime?.status === "online";
            const isActive = activeAgentId === agent.id;
            const avatarConfig = parseAvatarUrl(agent.avatar_url);

            return (
              <button
                key={agent.id}
                onClick={() => router.push(`/w/${slug}/agents/${agent.id}`)}
                aria-label={agent.name}
                className={cn(
                  "shrink-0 relative rounded-full transition-all",
                  isActive && "ring-2 ring-primary/50"
                )}
              >
                <div className="size-7">
                  {avatarConfig ? (
                    <AnimatedAvatar config={avatarConfig} size={28} className="rounded-full" isHovered={false} />
                  ) : (
                    <div className="size-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium">
                      {agent.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <span
                  className={cn(
                    "absolute -bottom-1 -right-1 size-2 rounded-full border border-background",
                    isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
                  )}
                />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
