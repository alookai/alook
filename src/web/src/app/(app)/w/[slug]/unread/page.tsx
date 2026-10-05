"use client";

import { useObservedRegion } from "@/lib/observability/regions";
import { viewEvidence } from "@/lib/observability/data-source";

import { useSelector } from "@tanstack/react-store";
import { useApplicationOwner } from "@/lib/application-owner";
import { useCallback, useRef } from "react";
import { useWorkspace } from "@/contexts/workspace-context";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { type InboxItem } from "@/lib/api";
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
  setInboxFilterTypes,
  type InboxFilterType,
} from "@/lib/inbox-filter";
import { useMarkAllInboxRead, useWorkspaceInbox } from "@/hooks/workspace/use-inbox";


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
  const { slug } = useWorkspace();
  const { decrement: decrementInboxCount } = useInboxCount();
  const { openAgentChat } = useAgentChatSheet();

  const { items, isPending: loading, hasNextPage: hasMore, isFetchingNextPage: loadingMore, fetchNextPage } = useWorkspaceInbox();
  const markAll = useMarkAllInboxRead();
  const application = useApplicationOwner();
  const filterTypes = useSelector(application.preferences, (state) => state.inboxFilterTypes);
  useObservedRegion("inbox", !loading, viewEvidence(items));
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200 && !loadingMore && hasMore) void fetchNextPage();
  }, [fetchNextPage, loadingMore, hasMore]);
  const handleMarkAllRead = () => markAll.mutate();
  const handleFilterToggle = (type: InboxFilterType, checked: boolean) => {
    const next = checked ? [...filterTypes, type] : filterTypes.filter((value) => value !== type);
    setInboxFilterTypes(application, next);
  };

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
