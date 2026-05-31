"use client";

import React from "react";
import { useSheetResize, SheetResizeHandle } from "@/components/ui/sheet-resize-handle";
import { useRouter } from "next/navigation";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Agent } from "@alook/shared";
import { AnimatedAvatar, parseAvatarUrl } from "@/components/avatar";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { ChannelBar } from "@/components/channel-bar";
import { AgentChatView } from "@/components/agent-chat/agent-chat-view";
import { ArrowUpRight, XIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface AgentChatSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Raw agent id — known before the resolved `agent` object. The chat body
   * mounts on this so it paints from cache without waiting for the agents array
   * to load (Part 2-b). The `agent` object is only used for the header.
   */
  agentId: string | null;
  agent: Agent | null;
  targetConvId?: string | null;
  scrollToTaskId?: string | null;
  scrollToMessageId?: string | null;
}

const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8;
const DEFAULT_WIDTH = 480;

export function AgentChatSheet({ open, onOpenChange, agentId, agent, targetConvId, scrollToTaskId, scrollToMessageId }: AgentChatSheetProps) {
  const { runtimes, activeTaskCounts } = useAgentContext();
  const { slug } = useWorkspace();
  const router = useRouter();
  const { width, onPointerDown, onPointerMove, onPointerUp } = useSheetResize({
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidthRatio: MAX_WIDTH_RATIO,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border flex flex-col"
      >
        <SheetResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />

        {/* Top-right action buttons */}
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
          {agentId && (() => {
            const params = new URLSearchParams();
            if (scrollToTaskId) params.set("task", scrollToTaskId);
            if (scrollToMessageId) params.set("msg", scrollToMessageId);
            if (targetConvId) params.set("conv", targetConvId);
            const qs = params.toString();
            const fullPageUrl = `/w/${slug}/agents/${agentId}${qs ? `?${qs}` : ""}`;
            return (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      href={fullPageUrl}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                        e.preventDefault();
                        onOpenChange(false);
                        router.push(fullPageUrl);
                      }}
                      className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
                    />
                  }
                >
                  <ArrowUpRight />
                </TooltipTrigger>
                <TooltipContent>Open full page</TooltipContent>
              </Tooltip>
            );
          })()}
          <SheetClose
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetClose>
        </div>

        <SheetHeader>
          <div className="flex items-center gap-3 pr-16">
            {agent && (() => {
              const avatarConfig = parseAvatarUrl(agent.avatar_url);
              const rt = runtimes.find((r) => r.id === agent.runtime_id);
              const isOnline = rt?.status === "online";
              const isWorking = !!isOnline && (activeTaskCounts[agent.id] ?? 0) > 0;
              return avatarConfig ? (
                <AnimatedAvatar config={avatarConfig} size={28} className="shrink-0 rounded-lg" isHovered={false} isWorking={isWorking} />
              ) : null;
            })()}
            <div className="flex items-baseline gap-2 min-w-0">
              <SheetTitle className="truncate shrink-0">
                {agent?.name ?? "Chat"}
              </SheetTitle>
              {agent?.email_handle && (
                <span className="text-xs text-muted-foreground truncate">{agent.email_handle}@alook.ai</span>
              )}
            </div>
          </div>
        </SheetHeader>

        {!targetConvId && (
          <div className="px-4 pb-2">
            <ChannelBar />
          </div>
        )}

        {agentId && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <AgentChatView
              key={`${agentId}-${targetConvId ?? ""}`}
              agentId={agentId}
              targetConvId={targetConvId}
              scrollToTaskId={scrollToTaskId}
              scrollToMessageId={scrollToMessageId}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
