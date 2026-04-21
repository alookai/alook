"use client";

import React, { useState } from "react";
import type { Message } from "@alook/shared";
import { cn } from "@/lib/utils";
import { Paperclip, X } from "lucide-react";

interface FollowUpBufferProps {
  bufferedMessages: Message[];
  onDelete: (messageId: string) => void;
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

const MAX_VISIBLE_STACK = 3;
const CARD_H = 32;
const STACK_GAP = 6;
const EXPANDED_GAP = 4;

export function FollowUpBuffer({
  bufferedMessages,
  onDelete,
}: FollowUpBufferProps) {
  const [expanded, setExpanded] = useState(false);
  const count = bufferedMessages.length;

  if (count === 0) return null;

  const visibleCount = Math.min(count, MAX_VISIBLE_STACK);
  const collapsedH = CARD_H + (visibleCount - 1) * STACK_GAP;
  const expandedH = count * CARD_H + (count - 1) * EXPANDED_GAP;

  return (
    <div className="relative px-5 pb-1">
      <div className="mx-auto max-w-2xl flex justify-center">
        <div
          className="relative w-full max-w-lg transition-[height] duration-200 ease-out"
          style={{ height: expanded ? expandedH : collapsedH }}
          onMouseEnter={() => setExpanded(true)}
          onMouseLeave={() => setExpanded(false)}
        >
          {bufferedMessages.map((msg, i) => {
            const fromBottom = count - 1 - i;
            const inStack = i >= count - visibleCount;
            const stackFromTop = inStack ? fromBottom : visibleCount;

            // Both states use bottom-based positioning.
            // The last card (fromBottom=0) never moves.
            const collapsedBottom = inStack ? fromBottom * STACK_GAP : 0;
            const expandedBottom = fromBottom * (CARD_H + EXPANDED_GAP);

            const collapsedScale = inStack ? 1 - fromBottom * 0.03 : 0.91;
            const collapsedOpacity = inStack ? 1 - fromBottom * 0.2 : 0;

            return (
              <div
                key={msg.id}
                className="absolute right-0 left-0 transition-all duration-200 ease-out"
                style={{
                  height: CARD_H,
                  zIndex: i + 1,
                  bottom: expanded ? expandedBottom : collapsedBottom,
                  transform: expanded ? "scale(1)" : `scale(${collapsedScale})`,
                  opacity: expanded ? 1 : collapsedOpacity,
                  pointerEvents: expanded || inStack ? "auto" : "none",
                }}
              >
                <div
                  className="h-full rounded-lg border bg-background/95 backdrop-blur-sm shadow-sm
                    flex items-center gap-2 px-3"
                >
                  <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums w-4 text-right">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 flex items-center gap-1.5">
                    <p className="text-[13px] text-muted-foreground leading-snug truncate">
                      {truncate(msg.content, 80)}
                    </p>
                    {msg.attachment_ids && msg.attachment_ids.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 shrink-0 text-[11px] text-muted-foreground/50">
                        <Paperclip className="size-2.5" />
                        {msg.attachment_ids.length}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(msg.id);
                    }}
                    className={cn(
                      "shrink-0 rounded-sm p-0.5 transition-all duration-150",
                      "text-muted-foreground/30 hover:text-foreground hover:bg-muted",
                      expanded ? "opacity-100" : "opacity-0",
                    )}
                    tabIndex={expanded ? 0 : -1}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              </div>
            );
          })}

          {!expanded && count > visibleCount && (
            <span className="absolute -top-4 right-1 text-[10px] text-muted-foreground/40 tabular-nums">
              +{count - visibleCount} more
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
