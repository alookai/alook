"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/contexts/workspace-context";
import { listAgentActivity, retryTask, type ActivityTask } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import {
  MessageSquare,
  Mail,
  CalendarDays,
  CircleDot,
  History,
  RotateCw,
  Loader2,
} from "lucide-react";
import { ScrollToBottomButton } from "@/components/ui/scroll-to-bottom-button";

const ACTIVITY_LIMIT = 30;

const STATUS_OPTIONS = [
  { label: "All", value: "" },
  { label: "Queued", value: "queued,dispatched" },
  { label: "Running", value: "running" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled,superseded" },
];

const TYPE_OPTIONS = [
  { label: "All", value: "" },
  { label: "Message", value: "user_dm_message" },
  { label: "Email", value: "email_notification" },
  { label: "Calendar", value: "calendar_event" },
];

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds >= 3600) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (totalSeconds >= 60) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
  }
  return `${totalSeconds}s`;
}

const TYPE_ICONS: Record<string, typeof MessageSquare> = {
  user_dm_message: MessageSquare,
  email_notification: Mail,
  calendar_event: CalendarDays,
};

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  dispatched: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Cancelled",
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "superseded"]);

function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === "completed"
      ? "bg-[oklch(0.72_0.19_145)]"
      : status === "failed"
        ? "bg-destructive"
        : status === "running"
          ? "bg-primary animate-pulse"
          : "bg-muted-foreground/40";

  return <span className={`size-1.5 rounded-full shrink-0 ${colorClass}`} />;
}

function ActivityRow({ task, slug, agentId, workspaceId, onRetry }: { task: ActivityTask; slug: string; agentId: string; workspaceId: string; onRetry: () => void }) {
  const Icon = TYPE_ICONS[task.type] ?? CircleDot;
  const duration = TERMINAL_STATUSES.has(task.status)
    ? formatDuration(task.started_at, task.completed_at)
    : null;
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRetrying(true);
    try {
      await retryTask(task.id, workspaceId);
      onRetry();
    } catch {
      // silently fail
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Link
      href={`/w/${slug}/agents/${agentId}?task=${task.id}&conv=${task.conversation_id}`}
      className="block px-4 py-3 border-b border-border/30 hover:bg-accent/30 transition-colors duration-150 cursor-pointer"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="shrink-0 size-3.5 text-muted-foreground" />
        <span className="text-sm text-foreground truncate flex-1 min-w-0">
          {task.prompt}
        </span>
        <Tooltip>
          <TooltipTrigger render={<span className="text-xs text-muted-foreground shrink-0 ml-2" />}>
            {relativeTime(task.created_at)}
          </TooltipTrigger>
          <TooltipContent>{new Date(task.created_at).toLocaleString()}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1.5 mt-1 ml-5.5">
        <StatusDot status={task.status} />
        <span className="text-xs text-muted-foreground">
          {STATUS_LABELS[task.status] ?? task.status}
        </span>
        {duration && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-xs text-muted-foreground">{duration}</span>
          </>
        )}
        {task.status === "failed" && task.error && (
          <>
            <span className="text-muted-foreground/40">—</span>
            <span className="text-xs text-destructive truncate max-w-50">
              {task.error}
            </span>
          </>
        )}
        {task.status === "failed" && (
          <Tooltip>
            <TooltipTrigger render={<Button
              variant="ghost"
              size="icon-sm"
              onClick={handleRetry}
              disabled={retrying}
              className="ml-auto text-muted-foreground"
            />}>
              {retrying
                ? <Loader2 className="size-3 animate-spin" />
                : <RotateCw className="size-3" />}
            </TooltipTrigger>
            <TooltipContent>Retry task</TooltipContent>
          </Tooltip>
        )}
      </div>
    </Link>
  );
}

function SkeletonRow({ promptWidth }: { promptWidth: string }) {
  return (
    <div className="px-4 py-3 border-b border-border/30">
      <div className="flex items-center gap-2">
        <Skeleton className="h-3.5 w-4 rounded shrink-0" />
        <Skeleton className={`h-3.5 rounded`} style={{ width: promptWidth }} />
        <Skeleton className="h-2.5 w-10 rounded shrink-0 ml-auto" />
      </div>
      <div className="flex items-center gap-1.5 mt-1 ml-5.5">
        <Skeleton className="h-2.5 w-20 rounded-full" />
        <Skeleton className="h-2.5 w-8 rounded" />
      </div>
    </div>
  );
}

export default function AgentActivityPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentId = params.id as string;
  const { slug, workspaceId } = useWorkspace();

  const [tasks, setTasks] = useState<ActivityTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);
  const initialScrollDone = useRef(false);

  const statusFilter = searchParams.get("status") ?? "";
  const typeFilter = searchParams.get("type") ?? "";

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentActivity(agentId, workspaceId, {
        limit: ACTIVITY_LIMIT,
        status: statusFilter || undefined,
        type: typeFilter || undefined,
      });
      setTasks(result.tasks);
      setHasMore(result.has_more);
      initialScrollDone.current = false;
    } catch {
      // error handled silently
    } finally {
      setLoading(false);
    }
  }, [agentId, workspaceId, statusFilter, typeFilter]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!loading && !initialScrollDone.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      initialScrollDone.current = true;
    }
  }, [loading, tasks]);

  const loadOlderTasks = useCallback(async () => {
    if (isFetchingRef.current || !hasMore || tasks.length === 0) return;
    isFetchingRef.current = true;
    setLoadingMore(true);

    const el = scrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;

    try {
      const oldest = tasks[0];
      const result = await listAgentActivity(agentId, workspaceId, {
        limit: ACTIVITY_LIMIT,
        before: oldest.created_at,
        beforeId: oldest.id,
        status: statusFilter || undefined,
        type: typeFilter || undefined,
      });

      if (result.tasks.length === 0) {
        setHasMore(false);
        return;
      }

      setHasMore(result.has_more);
      setTasks((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const unique = result.tasks.filter((t) => !existingIds.has(t.id));
        return [...unique, ...prev];
      });

      requestAnimationFrame(() => {
        if (el) {
          const newScrollHeight = el.scrollHeight;
          el.scrollTop = newScrollHeight - prevScrollHeight;
        }
      });
    } finally {
      isFetchingRef.current = false;
      setLoadingMore(false);
    }
  }, [agentId, workspaceId, tasks, hasMore, statusFilter, typeFilter]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!loadingMore && hasMore && el.scrollTop < 80) {
      loadOlderTasks();
    }
  }, [loadOlderTasks, loadingMore, hasMore]);

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const newParams = new URLSearchParams(searchParams.toString());
      if (value) {
        newParams.set(key, value);
      } else {
        newParams.delete(key);
      }
      const pathname = `/w/${slug}/agents/${agentId}/activity`;
      const qs = newParams.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, slug, agentId, searchParams]
  );

  return (
    <>
      {/* Filter bar */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2.5">
        <Select value={statusFilter} onValueChange={(v) => updateFilter("status", v ?? "")}>
          <SelectTrigger className="w-35 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <SelectValue placeholder="Status: All" />
          </SelectTrigger>
          <SelectPopup>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label === "All" ? "Status: All" : opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        <Select value={typeFilter} onValueChange={(v) => updateFilter("type", v ?? "")}>
          <SelectTrigger className="w-32.5 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <SelectValue placeholder="Type: All" />
          </SelectTrigger>
          <SelectPopup>
            {TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label === "All" ? "Type: All" : opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Scroll container */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto thin-scrollbar"
          onScroll={handleScroll}
        >
          {loading ? (
            <div className="flex flex-col">
              <SkeletonRow promptWidth="40%" />
              <SkeletonRow promptWidth="55%" />
              <SkeletonRow promptWidth="48%" />
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
              <History className="size-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No activity yet</p>
              {(statusFilter || typeFilter) && (
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Try changing your filters
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col animate-[fade-up_400ms_ease-out_both]">
              {loadingMore && (
                <>
                  <SkeletonRow promptWidth="48%" />
                  <SkeletonRow promptWidth="40%" />
                </>
              )}
              {tasks.map((task) => (
                <ActivityRow
                  key={task.id}
                  task={task}
                  slug={slug}
                  agentId={agentId}
                  workspaceId={workspaceId}
                  onRetry={loadInitial}
                />
              ))}
            </div>
          )}
        </div>
        <ScrollToBottomButton scrollRef={scrollRef} />
      </div>
    </>
  );
}
