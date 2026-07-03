"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspace } from "@/contexts/workspace-context";
import { listFlaggedItems, unflagMessage as apiUnflagMessage, type FlaggedItem } from "@/lib/api";
import { useFlagCount } from "@/contexts/flag-count-context";
import { useAgentChatSheet } from "@/contexts/agent-chat-sheet-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Flag, X } from "lucide-react";
import { AgentAvatar } from "@/components/avatar";
import { relativeTime } from "@/lib/time";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const FLAG_LIMIT = 30;

function FlagRow({
  item,
  slug,
  onClick,
  onUnflag,
}: {
  item: FlaggedItem;
  slug: string;
  onClick?: (e: React.MouseEvent) => void;
  onUnflag: () => void;
}) {
  return (
    <a
      href={`/w/${slug}/agents/${item.agent_id}?conv=${item.conversation_id}`}
      onClick={onClick}
      className="block px-4 py-3 border-b border-border/30 hover:bg-accent/30 transition-colors duration-150 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={item.agent_name} avatarUrl={item.agent_avatar_url} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-foreground truncate flex-1 min-w-0">
              {item.message_content}
            </span>
            <Tooltip>
              <TooltipTrigger render={<span className="text-xs text-muted-foreground shrink-0 ml-2" />}>
                {relativeTime(item.flagged_at)}
              </TooltipTrigger>
              <TooltipContent>{new Date(item.flagged_at).toLocaleString()}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {item.agent_name && (
              <span className="text-xs font-medium text-muted-foreground">{item.agent_name}</span>
            )}
            {item.conversation_title && (
              <>
                <span className="text-muted-foreground/40">&middot;</span>
                <span className="text-xs text-muted-foreground">{item.conversation_title}</span>
              </>
            )}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onUnflag();
                }}
                className="text-muted-foreground"
              />
            }
          >
            <X className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Unflag</TooltipContent>
        </Tooltip>
      </div>
    </a>
  );
}

function SkeletonRow({ promptWidth }: { promptWidth: string }) {
  return (
    <div className="px-4 py-3 border-b border-border/30">
      <div className="flex items-center gap-2">
        <Skeleton className="size-8 rounded-full shrink-0" />
        <div className="flex-1">
          <Skeleton className="h-3.5 rounded" style={{ width: promptWidth }} />
          <div className="flex items-center gap-2 mt-2">
            <Skeleton className="h-2.5 w-16 rounded" />
            <Skeleton className="h-2.5 w-8 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function FlagsPage() {
  const { slug, workspaceId } = useWorkspace();
  const { decrement, increment } = useFlagCount();
  const { openAgentChat } = useAgentChatSheet();

  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listFlaggedItems(workspaceId, { limit: FLAG_LIMIT });
      setItems(result.items);
      setHasMore(result.has_more);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const loadMore = useCallback(async () => {
    if (isFetchingRef.current || !hasMore || items.length === 0) return;
    isFetchingRef.current = true;
    setLoadingMore(true);
    try {
      const oldest = items[items.length - 1];
      const result = await listFlaggedItems(workspaceId, {
        limit: FLAG_LIMIT,
        before: oldest.flagged_at,
      });
      if (result.items.length === 0) {
        setHasMore(false);
        return;
      }
      setHasMore(result.has_more);
      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id));
        const unique = result.items.filter((i) => !existingIds.has(i.id));
        return [...prev, ...unique];
      });
    } finally {
      isFetchingRef.current = false;
      setLoadingMore(false);
    }
  }, [workspaceId, items, hasMore]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!loadingMore && hasMore && nearBottom) {
      loadMore();
    }
  }, [loadMore, loadingMore, hasMore]);

  const handleUnflag = useCallback(async (item: FlaggedItem) => {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    decrement();
    try {
      await apiUnflagMessage(workspaceId, item.message_id);
    } catch {
      setItems((prev) => [...prev, item].sort((a, b) => b.flagged_at.localeCompare(a.flagged_at)));
      increment();
    }
  }, [workspaceId, decrement, increment]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Flagged</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">
            Messages you flagged for later.
          </p>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto thin-scrollbar"
      >
        {loading ? (
          <>
            <SkeletonRow promptWidth="60%" />
            <SkeletonRow promptWidth="45%" />
            <SkeletonRow promptWidth="70%" />
            <SkeletonRow promptWidth="55%" />
          </>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 py-20">
            <Flag className="size-10 opacity-30" />
            <p className="text-sm">No flagged messages</p>
          </div>
        ) : (
          <>
            {items.map((item) => (
              <FlagRow
                key={item.id}
                item={item}
                slug={slug}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  openAgentChat(item.agent_id, { conversationId: item.conversation_id, messageId: item.message_id });
                }}
                onUnflag={() => handleUnflag(item)}
              />
            ))}
            {loadingMore && <SkeletonRow promptWidth="50%" />}
          </>
        )}
      </div>
    </div>
  );
}
