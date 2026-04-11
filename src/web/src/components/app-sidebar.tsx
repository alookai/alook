"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { Settings2, Plus, Loader2, LayoutGrid } from "lucide-react";
import { NavUser } from "@/components/nav-user";

export function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { agents, loading } = useAgentContext();
  const { slug } = useWorkspace();

  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));

  const prefix = `/w/${slug}`;
  const isRuntimes = pathname === `${prefix}/runtimes`;
  const isCreateAgent = pathname === `${prefix}/agents/new`;

  // Detect active agent from ?agent= param or /w/[slug]/agents/[id] route
  const urlAgentId = searchParams.get("agent");
  const pathnameAgentMatch = pathname.match(/^\/w\/[^/]+\/agents\/([^/]+)/);
  const activeAgentId = urlAgentId ?? pathnameAgentMatch?.[1] ?? null;

  const handleAgentClick = (agentId: string) => {
    router.push(`${prefix}/agents/${agentId}/chat`);
  };

  return (
    <nav className="flex h-full w-14 flex-col items-center py-2 gap-0.5">
      {/* Logo */}
      <div className="mb-1 pb-2 border-b border-border/50">
        <Logo size="sm" iconOnly />
      </div>

      {/* Agent avatars */}
      <div className="flex flex-1 w-full flex-col items-center gap-1.5 overflow-y-auto py-1 scrollbar-none">
        {loading ? (
          <div className="flex items-center justify-center size-10">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          sorted.map((agent) => {
            const isActive = activeAgentId === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                title={agent.name}
                onClick={() => handleAgentClick(agent.id)}
                className={cn(
                  "relative flex shrink-0 items-center justify-center size-10 rounded-xl text-sm font-medium transition-colors duration-200 cursor-pointer",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-secondary text-secondary-foreground hover:bg-accent"
                )}
              >
                {agent.name.charAt(0).toUpperCase()}
              </button>
            );
          })
        )}

        {/* Create agent */}
        <button
          type="button"
          title="New agent"
          onClick={() => router.push(`${prefix}/agents/new`)}
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
          title="Runtimes"
          onClick={() => router.push(`${prefix}/runtimes`)}
          className={cn(
            "flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            isRuntimes && "bg-accent text-foreground"
          )}
        >
          <Settings2 className="size-4" />
        </button>

        <button
          type="button"
          title="Workspaces"
          onClick={() => router.push("/workspaces")}
          className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-200 cursor-pointer"
        >
          <LayoutGrid className="size-4" />
        </button>

        <NavUser />
      </div>
    </nav>
  );
}
