"use client";

import { useState } from "react";
import type { Agent } from "@alook/shared";
import { cn } from "@/lib/utils";
import { PinIcon, PinOffIcon } from "lucide-react";
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

export function AgentSidebarButton({
  agent,
  isActive,
  isPinned,
  isOnline,
  taskCount,
  onClick,
  onPin,
  onUnpin,
  extraContextMenuItems,
  hidePin,
  isDragActive,
}: {
  agent: Agent;
  isActive: boolean;
  isPinned: boolean;
  isOnline: boolean;
  taskCount: number;
  onClick: () => void;
  onPin: () => void;
  onUnpin: () => void;
  extraContextMenuItems?: React.ReactNode;
  hidePin?: boolean;
  isDragActive?: boolean;
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
          openOnHover={!isDragActive}
          delay={200}
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
          {!hidePin && (isPinned ? (
            <ContextMenuItem onClick={onUnpin}>
              <PinOffIcon className="size-3.5 mr-1.5" />
              Unpin
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={onPin}>
              <PinIcon className="size-3.5 mr-1.5" />
              Pin to top
            </ContextMenuItem>
          ))}
          {extraContextMenuItems}
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent side="right" className="w-fit max-w-80">
        <AgentPreviewCard agent={agent} isOnline={isOnline} activeTaskCount={taskCount} />
      </PopoverContent>
    </Popover>
  );
}
