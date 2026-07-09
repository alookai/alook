"use client";

import { useState, useCallback } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listFlaggedItems, type FlaggedItem } from "@/lib/api";
import { useWorkspace } from "@/contexts/workspace-context";
import { useFlagCount } from "@/contexts/flag-count-context";
import { useAgentChatSheet } from "@/contexts/agent-chat-sheet-context";
import { AgentAvatar } from "@/components/avatar";
import { relativeTime } from "@/lib/time";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Flag, ArrowUpRight } from "lucide-react";
import Link from "next/link";

function FlagPopoverRow({
  item,
  slug,
  onClick,
}: {
  item: FlaggedItem;
  slug: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <a
      href={`/w/${slug}/agents/${item.agent_id}?conv=${item.conversation_id}`}
      onClick={onClick}
      className="block w-full py-2 px-2 hover:bg-muted rounded-md transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={item.agent_name} avatarUrl={item.agent_avatar_url} size={24} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium truncate flex-1 min-w-0">
              {item.agent_name}
            </span>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
              {relativeTime(item.flagged_at)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate mt-1">
            {item.message_content}
          </p>
        </div>
      </div>
    </a>
  );
}

const POPOVER_LIMIT = 30;

export function FlagPopover({
  isActive,
  onNavigate,
}: {
  isActive?: boolean;
  onNavigate?: () => void;
}) {
  const { slug, workspaceId } = useWorkspace();
  const { count: flagCount } = useFlagCount();
  const { openAgentChat } = useAgentChatSheet();
  const [items, setItems] = useState<FlaggedItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const fetchItems = useCallback(async () => {
    setItems(null);
    setLoading(true);
    try {
      const result = await listFlaggedItems(workspaceId, { limit: POPOVER_LIMIT });
      setItems(result.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const handleRowClick = useCallback((item: FlaggedItem, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setOpen(false);
    onNavigate?.();
    openAgentChat(item.agent_id, { conversationId: item.conversation_id, messageId: item.message_id });
  }, [onNavigate, openAgentChat]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) fetchItems();
      }}
    >
      <Tooltip open={open ? false : tooltipOpen} onOpenChange={setTooltipOpen}>
        <PopoverTrigger
          render={
            <TooltipTrigger render={
              <button
                type="button"
                className={cn(
                  "relative flex items-center justify-center size-10 rounded-xl transition-colors duration-200 cursor-pointer",
                  "text-muted-foreground hover:text-foreground hover:bg-accent",
                  isActive && "bg-accent text-foreground"
                )}
              />
            } />
          }
        >
          <Flag className="size-4" />
          {flagCount > 0 && (
            <span className="absolute top-1 right-1 flex items-center justify-center min-w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold px-1">
              {flagCount > 99 ? "99+" : flagCount}
            </span>
          )}
        </PopoverTrigger>
        <TooltipContent side="right">Flagged</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <span className="text-xs font-medium">Flagged</span>
          <Link
            href={`/w/${slug}/flags`}
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="flex items-center justify-center size-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
        <div className="p-1">
          {loading ? (
            <div className="space-y-1">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="py-2 px-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-6 rounded-full shrink-0" />
                    <Skeleton className="h-3 w-20" />
                    <div className="flex-1" />
                    <Skeleton className="h-2.5 w-8" />
                  </div>
                  <Skeleton className="h-3 w-3/4 mt-2 ml-8" />
                </div>
              ))}
            </div>
          ) : !items || items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
              <Flag className="size-6 opacity-30" />
              <p className="text-xs">No flagged messages</p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto thin-scrollbar">
              {items.map((item) => (
                <FlagPopoverRow
                  key={item.id}
                  item={item}
                  slug={slug}
                  onClick={(e) => handleRowClick(item, e)}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
