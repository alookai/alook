"use client";

import { useState, useCallback } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listInboxItems, type InboxItem } from "@/lib/api";
import { useWorkspace } from "@/contexts/workspace-context";
import { useInboxCount } from "@/contexts/inbox-count-context";
import { useAgentChatSheet } from "@/contexts/agent-chat-sheet-context";
import { AgentAvatar } from "@/components/avatar";
import { relativeTime } from "@/lib/time";
import { getInboxFilterTypes } from "@/lib/inbox-filter";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Inbox, ArrowUpRight } from "lucide-react";
import Link from "next/link";

function InboxPopoverRow({
  item,
  slug,
  onClick,
}: {
  item: InboxItem;
  slug: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <a
      href={`/w/${slug}/agents/${item.agent_id}?conv=${item.id}`}
      onClick={onClick}
      className="block w-full py-1.5 px-2 hover:bg-muted rounded-md transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={item.agent_name} avatarUrl={item.agent_avatar_url} size={24} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium truncate flex-1 min-w-0">
              {item.agent_name}
            </span>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
              {relativeTime(item.latest_response_at)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {item.root_prompt ?? item.title}
          </p>
        </div>
      </div>
    </a>
  );
}

const POPOVER_LIMIT = 30;

export function InboxPopover({
  isActive,
  onNavigate,
}: {
  isActive?: boolean;
  onNavigate?: () => void;
}) {
  const { slug, workspaceId } = useWorkspace();
  const { count: inboxCount, decrement, refresh } = useInboxCount();
  const { openAgentChat } = useAgentChatSheet();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const fetchItems = useCallback(async () => {
    setItems(null);
    setLoading(true);
    try {
      const result = await listInboxItems(workspaceId, {
        limit: POPOVER_LIMIT,
        types: getInboxFilterTypes(),
      });
      setItems(result.items);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const handleRowClick = useCallback((item: InboxItem, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    decrement();
    setOpen(false);
    onNavigate?.();
    openAgentChat(item.agent_id, { conversationId: item.id });
  }, [decrement, onNavigate, openAgentChat]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          fetchItems();
          refresh();
        }
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
          <Inbox className="size-4" />
          {inboxCount > 0 && (
            <span className="absolute top-1 right-1 flex items-center justify-center min-w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold px-0.5">
              {inboxCount > 99 ? "99+" : inboxCount}
            </span>
          )}
        </PopoverTrigger>
        <TooltipContent side="right">Unread</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
          <span className="text-xs font-medium">Unread</span>
          <Link
            href={`/w/${slug}/unread`}
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
                <div key={i} className="py-1.5 px-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-6 rounded-full shrink-0" />
                    <Skeleton className="h-3 w-20" />
                    <div className="flex-1" />
                    <Skeleton className="h-2.5 w-8" />
                  </div>
                  <Skeleton className="h-3 w-3/4 mt-1.5 ml-8" />
                </div>
              ))}
            </div>
          ) : !items || items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-muted-foreground">
              <Inbox className="size-6 opacity-30" />
              <p className="text-xs">No unread messages</p>
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {items.map((item) => (
                <InboxPopoverRow
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
