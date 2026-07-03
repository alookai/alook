"use client";

import { useCallback, useState } from "react";
import { toAlookAddress } from "@alook/shared";
import type { Agent } from "@alook/shared";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { AnimatedAvatar, parseAvatarUrl } from "@/components/avatar";
import { AgentStatusBadge } from "@/components/agent-status-badge";
import { cn } from "@/lib/utils";

interface AgentPreviewCardProps {
  agent: Agent;
  isOnline?: boolean;
  activeTaskCount?: number;
  variant?: "default" | "compact";
  isHovered?: boolean;
}

export function AgentPreviewCard({
  agent,
  isOnline,
  activeTaskCount,
  variant = "default",
  isHovered,
}: AgentPreviewCardProps) {
  const [copied, setCopied] = useState(false);
  const email = agent.email_handle ? toAlookAddress(agent.email_handle) : null;
  const isCompact = variant === "compact";

  const handleCopy = useCallback(async () => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      toast.success("Email copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy email");
    }
  }, [email]);

  if (isCompact) {
    return (
      <div className="flex items-center gap-2 p-0">
        {(() => {
          const avatarConfig = parseAvatarUrl(agent.avatar_url);
          if (avatarConfig) {
            return <AnimatedAvatar config={avatarConfig} size={32} className="shrink-0 rounded-xl" isHovered={isHovered ?? false} isWorking={!!isOnline && (activeTaskCount ?? 0) > 0} />;
          }
          return (
            <div className="flex items-center justify-center size-8 rounded-xl bg-secondary text-secondary-foreground text-xs font-medium shrink-0">
              {agent.name.charAt(0).toUpperCase()}
            </div>
          );
        })()}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate max-w-35">{agent.name}</p>
            {email && (
              <span className="text-xs text-muted-foreground truncate">{email}</span>
            )}
          </div>
          {isOnline !== undefined && (
            <div className="pointer-events-none mt-1">
              <AgentStatusBadge
                isOnline={isOnline}
                taskCount={activeTaskCount ?? 0}
                agentId={agent.id}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-1">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium truncate">{agent.name}</p>
        <span className="flex-1" />
        {isOnline !== undefined && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className={cn(
              "size-1.5 rounded-full",
              !isOnline ? "bg-status-offline" : "bg-status-online"
            )} />
            {!isOnline ? "Offline" : (activeTaskCount ?? 0) > 0 ? "Working" : null}
          </span>
        )}
      </div>
      {email && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground truncate">{email}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
            className="shrink-0 p-1 rounded-sm text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
          >
            {copied ? (
              <Check className="size-3 text-green-500" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        </div>
      )}
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
      )}
    </div>
  );
}
