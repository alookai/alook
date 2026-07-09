"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { listInboxItems, markAllInboxRead, type InboxItem } from "@/lib/api";
import { useInboxCount } from "@/contexts/inbox-count-context";
import { useAgentChatSheet } from "@/contexts/agent-chat-sheet-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Inbox, ListFilter, CheckCheck } from "lucide-react";
import { AgentAvatar } from "@/components/avatar";
import { relativeTime } from "@/lib/time";
import {
  INBOX_FILTER_TYPES,
  INBOX_FILTER_LABELS,
  MANDATORY_INBOX_TYPES,
  getInboxFilterTypes,
  setInboxFilterTypes,
  type InboxFilterType,
} from "@/lib/inbox-filter";
import type { WsMessage } from "@alook/shared";

const INBOX_LIMIT = 30;

function StatusDot({ status }: { status: string | null }) {
  const colorClass =
    status === "completed"
      ? "bg-[oklch(0.72_0.19_145)]"
      : status === "failed"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return <span className={`size-1.5 rounded-full shrink-0 ${colorClass}`} />;
}

const TYPE_LABELS: Record<string, string> = {
  user_dm_message: "DM",
  calendar_event: "Calendar",
  email_notification: "Email",
};

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const label = TYPE_LABELS[type] ?? type;
  return (
    <span className="text-[10px] leading-none px-2 py-1 rounded-full bg-muted text-muted-foreground font-medium">
      {label}
    </span>
  );
}

function InboxRow({ item, slug, onClick }: { item: InboxItem; slug: string; onClick?: (e: React.MouseEvent) => void }) {
  const statusLabel = item.root_task_status === "failed" ? "Failed" : "Completed";

  return (
    <a
      href={`/w/${slug}/agents/${item.agent_id}?conv=${item.id}`}
      onClick={onClick}
      className="block px-4 py-3 border-b border-border/30 hover:bg-accent/30 transition-colors duration-150 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={item.agent_name} avatarUrl={item.agent_avatar_url} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-foreground truncate flex-1 min-w-0">
              {item.root_prompt ?? item.title}
            </span>
            <Tooltip>
              <TooltipTrigger render={<span className="text-xs text-muted-foreground shrink-0 ml-2" />}>
                {relativeTime(item.latest_response_at)}
              </TooltipTrigger>
              <TooltipContent>{new Date(item.latest_response_at).toLocaleString()}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {item.agent_name && (
              <>
                <span className="text-xs font-medium text-muted-foreground">{item.agent_name}</span>
                <span className="text-muted-foreground/40">&middot;</span>
              </>
            )}
            <StatusDot status={item.root_task_status} />
            <span className="text-xs text-muted-foreground">{statusLabel}</span>
            <TypeBadge type={item.root_task_type} />
          </div>
          <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-1">
            {item.latest_response}
          </p>
        </div>
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
          <Skeleton className="h-2.5 w-3/4 rounded mt-2" />
        </div>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const { slug, workspaceId } = useWorkspace();
  const { subscribeWs } = useAgentContext();
  const { count, refresh: refreshInboxCount, decrement: decrementInboxCount } = useInboxCount();
  const { openAgentChat } = useAgentChatSheet();

  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filterTypes, setFilterTypes] = useState<InboxFilterType[]>(getInboxFilterTypes);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);
  const filterTypesRef = useRef(filterTypes);
  useEffect(() => { filterTypesRef.current = filterTypes; });

  const loadInitial = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const result = await listInboxItems(workspaceId, { limit: INBOX_LIMIT, types: filterTypesRef.current });
      setItems(result.items);
      setHasMore(result.has_more);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const refreshInboxCountRef = useRef(refreshInboxCount);
  useEffect(() => { refreshInboxCountRef.current = refreshInboxCount; });

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    refreshInboxCountRef.current();
  }, []);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "task.updated" && (msg.status === "completed" || msg.status === "failed")) {
        loadInitial({ silent: true });
      }
    });
  }, [subscribeWs, loadInitial]);

  const lastSeenCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (lastSeenCountRef.current !== null && count > lastSeenCountRef.current) {
      const timer = setTimeout(() => loadInitial({ silent: true }), 1500);
      lastSeenCountRef.current = count;
      return () => clearTimeout(timer);
    }
    lastSeenCountRef.current = count;
  }, [count, loadInitial]);

  const loadMore = useCallback(async () => {
    if (isFetchingRef.current || !hasMore || items.length === 0) return;
    isFetchingRef.current = true;
    setLoadingMore(true);
    try {
      const oldest = items[items.length - 1];
      const result = await listInboxItems(workspaceId, {
        limit: INBOX_LIMIT,
        before: oldest.latest_response_at,
        types: filterTypesRef.current,
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

  const handleMarkAllRead = useCallback(async () => {
    setItems([]);
    setHasMore(false);
    try {
      await markAllInboxRead(workspaceId);
      refreshInboxCount();
    } catch {
      loadInitial();
    }
  }, [workspaceId, loadInitial, refreshInboxCount]);

  const handleFilterToggle = useCallback((type: InboxFilterType, checked: boolean) => {
    const next = checked
      ? [...filterTypesRef.current, type]
      : filterTypesRef.current.filter((t) => t !== type);
    setFilterTypes(next);
    setInboxFilterTypes(next);
    filterTypesRef.current = next;
    loadInitial();
    refreshInboxCount();
  }, [loadInitial, refreshInboxCount]);

  const activeFilterCount = filterTypes.length - MANDATORY_INBOX_TYPES.length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Unread</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">
            Unread responses from your agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <ListFilter className="size-3.5" />
              <span>Filter</span>
              {activeFilterCount > 0 && (
                <span className="size-4 flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium leading-none">
                  {activeFilterCount}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" className="w-48">
              <p className="text-xs font-medium text-muted-foreground mb-2">Show in inbox:</p>
              <div className="flex flex-col gap-2">
                {INBOX_FILTER_TYPES.map((type) => {
                  const isMandatory = MANDATORY_INBOX_TYPES.includes(type);
                  const isChecked = filterTypes.includes(type);
                  return (
                    <label key={type} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={isChecked}
                        disabled={isMandatory}
                        onCheckedChange={(checked) => handleFilterToggle(type, !!checked)}
                      />
                      <span className="text-sm">{INBOX_FILTER_LABELS[type]}</span>
                    </label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>
          {!loading && items.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMarkAllRead}
              className="text-xs text-muted-foreground"
            >
              <CheckCheck className="size-3.5" />
              <span>Mark all as read</span>
            </Button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
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
            <Inbox className="size-10 opacity-30" />
            <p className="text-sm">No unread messages</p>
          </div>
        ) : (
          <>
            {items.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                slug={slug}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  decrementInboxCount();
                  openAgentChat(item.agent_id, { conversationId: item.id });
                }}
              />
            ))}
            {loadingMore && <SkeletonRow promptWidth="50%" />}
          </>
        )}
      </div>
    </div>
  );
}
