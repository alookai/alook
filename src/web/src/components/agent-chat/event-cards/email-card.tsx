import React, { useState, useCallback } from "react";
import { relativeTime } from "@/lib/time";
import { AnimatedAvatar, parseAvatarUrl, type AvatarConfig } from "@/components/avatar";
import { ChevronRight, MessageSquare } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useLongPress } from "@/hooks/use-long-press";
import type { Agent } from "@alook/shared";

export function EmailCard({
  subject,
  address,
  direction,
  onClick,
  timestamp,
  isInternal,
  internalHandle,
  targetConvId,
  targetAgentId,
  agents,
  onAgentChatOpen,
  touchAction,
}: {
  subject: string;
  address: string;
  direction: "inbound" | "outbound";
  onClick?: () => void;
  timestamp?: string;
  isInternal?: boolean;
  internalHandle?: string;
  targetConvId?: string;
  targetAgentId?: string;
  agents?: Agent[];
  onAgentChatOpen?: (agentId: string, targetConvId: string) => void;
  touchAction?: { label: string; onClick: () => void } | null;
}) {
  const [resolvedAgent, setResolvedAgent] = useState<{ name: string; avatarConfig: AvatarConfig | null } | null>(null);
  const [hoverResolved, setHoverResolved] = useState(false);
  const [touchSheetOpen, setTouchSheetOpen] = useState(false);

  const longPressHandlers = useLongPress(() => {
    if (touchAction) setTouchSheetOpen(true);
  });

  const handlePointerEnter = useCallback(() => {
    if (!isInternal || hoverResolved) return;
    setHoverResolved(true);
    const agent = agents?.find((a: Agent) => a.email_handle === internalHandle);
    if (agent) {
      setResolvedAgent({ name: agent.name, avatarConfig: parseAvatarUrl(agent.avatar_url) });
    }
  }, [isInternal, hoverResolved, agents, internalHandle]);
  return (
    <>
    <button
      type="button"
      onClick={(e) => {
        if (touchAction && longPressHandlers.onClick) {
          longPressHandlers.onClick(e);
          if (e.defaultPrevented) return;
        }
        onClick?.();
      }}
      disabled={!onClick}
      onPointerEnter={handlePointerEnter}
      {...(touchAction ? { onPointerDown: longPressHandlers.onPointerDown, onPointerMove: longPressHandlers.onPointerMove, onPointerUp: longPressHandlers.onPointerUp, onPointerCancel: longPressHandlers.onPointerCancel, onPointerLeave: longPressHandlers.onPointerLeave } : {})}
      className={`card-grain w-104 max-w-full rounded-(--radius) border border-(--border) bg-(--paper) text-left flex flex-col cursor-pointer [transition:translate_.2s_cubic-bezier(.2,.8,.2,1),box-shadow_.2s_ease] hover:-translate-y-0.5 [box-shadow:var(--e1)] hover:[box-shadow:var(--e2)] ${isInternal && targetConvId ? "overflow-visible group/ecard relative hover:z-20" : "overflow-hidden"}`}
    >
      <span className="h-2.5 relative block">
        <svg
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
        >
          <path
            d="M8,-1 L50,9 L92,-1"
            stroke="var(--te)"
            strokeWidth="2.5"
            opacity="0.4"
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="p-3 flex flex-col">
        <span className="flex items-start gap-1 mb-1">
          <span className="text-[0.72rem] text-(--muted-foreground) flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">
            {direction === "inbound" ? "from " : "to "}
            {address}
          </span>
          <span className="shrink-0 flex flex-col items-end gap-1">
            {timestamp && (
              <span className="text-[0.62rem] font-mono text-muted-foreground/65">
                {relativeTime(timestamp)}
              </span>
            )}
            <span className="text-[0.5rem] font-bold uppercase tracking-wider text-(--te) px-1 py-1 rounded-[3px] border-[1.5px] border-(--te) opacity-45 -rotate-3">
              {direction === "inbound" ? "Inbound" : "Sent"}
            </span>
          </span>
        </span>
        <span className="text-[0.95rem] font-semibold tracking-[-0.01em] leading-[1.35] line-clamp-2">
          {subject}
        </span>
      </span>
      {isInternal && resolvedAgent && targetConvId && (
        <span
          className="absolute -bottom-2 left-1/2 -translate-x-1/2 translate-y-1 opacity-0 group-hover/ecard:opacity-100 group-hover/ecard:translate-y-0 transition-all duration-200 ease-out pointer-events-none group-hover/ecard:pointer-events-auto z-10"
        >
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (targetConvId && targetAgentId) onAgentChatOpen?.(targetAgentId, targetConvId);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                if (targetConvId && targetAgentId) onAgentChatOpen?.(targetAgentId, targetConvId);
              }
            }}
            className="flex items-center gap-2 py-1 pl-0.5 pr-2 bg-(--paper) border border-(--border) rounded-full shadow-md hover:bg-(--secondary) cursor-pointer whitespace-nowrap"
          >
            {resolvedAgent.avatarConfig && (
              <AnimatedAvatar config={resolvedAgent.avatarConfig} size={20} isHovered={false} className="rounded-full" />
            )}
            <span className="text-[0.62rem] font-semibold opacity-80">{resolvedAgent.name}</span>
            <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/45 -ml-1" />
          </span>
        </span>
      )}
    </button>
    {touchAction && (
      <Sheet open={touchSheetOpen} onOpenChange={setTouchSheetOpen}>
        <SheetContent side="bottom" showCloseButton={false} className="rounded-t-2xl p-2">
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => {
                touchAction.onClick();
                setTouchSheetOpen(false);
              }}
              className="flex items-center gap-3 rounded-lg px-3 py-3 text-left text-[0.95rem] active:bg-muted text-foreground"
            >
              <span className="text-muted-foreground"><MessageSquare className="w-5 h-5" /></span>
              {touchAction.label}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    )}
    </>
  );
}
