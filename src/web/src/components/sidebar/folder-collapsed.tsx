"use client";

import type { Agent } from "@alook/shared";
import type { AgentFolder } from "@/hooks/use-agent-folders";
import { parseAvatarUrl } from "@/components/avatar";
import { AnimatedAvatar } from "@/components/avatar/animated-avatar";
import { cn } from "@/lib/utils";

const MAX_STACKED = 3;

export function FolderCollapsed({
  folder,
  agents,
  isActive,
  onClick,
}: {
  folder: AgentFolder;
  agents: Agent[];
  isActive: boolean;
  onClick: () => void;
}) {
  const folderAgents = folder.agentIds
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as Agent[];

  const displayed = folderAgents.slice(0, MAX_STACKED);
  const remaining = folderAgents.length - displayed.length;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex shrink-0 items-center justify-center size-10 rounded-xl transition-all duration-200 cursor-pointer",
        "bg-secondary/50 border border-border/30",
        isActive
          ? "ring-2 ring-primary/50 shadow-sm"
          : "hover:bg-accent"
      )}
    >
      <div className="relative flex items-center justify-center" style={{ width: 30, height: 20 }}>
        {displayed.map((agent, i) => {
          const avatarConfig = parseAvatarUrl(agent.avatar_url);
          const offset = i * 6;
          return (
            <div
              key={agent.id}
              className="absolute rounded-full overflow-hidden ring-1 ring-background"
              style={{
                width: 20,
                height: 20,
                left: offset,
                zIndex: i + 1,
              }}
            >
              {avatarConfig ? (
                <AnimatedAvatar config={avatarConfig} size={20} className="rounded-full" isHovered={false} />
              ) : (
                <div className="flex items-center justify-center size-full bg-muted text-[8px] font-medium">
                  {agent.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {remaining > 0 && (
        <span className="absolute bottom-0 right-0 flex items-center justify-center min-w-3.5 h-3.5 rounded-full bg-muted text-muted-foreground text-[8px] font-bold ring-1 ring-background">
          +{remaining}
        </span>
      )}
    </button>
  );
}
