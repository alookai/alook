"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/contexts/workspace-context";
import { useChannel } from "@/contexts/channel-context";
import { listTraces, listAgents, type TraceListItem } from "@/lib/api";
import type { Agent } from "@alook/shared";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { GitBranch, RefreshCw } from "lucide-react";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";

const TRACE_LIMIT = 30;

const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
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

function formatDuration(startedAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
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

function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === "completed"
      ? "bg-[oklch(0.72_0.19_145)]"
      : status === "failed"
        ? "bg-destructive"
        : status === "active"
          ? "bg-primary animate-pulse"
          : "bg-muted-foreground/40";
  return <span className={`size-1.5 rounded-full shrink-0 ${colorClass}`} />;
}

function AgentAvatar({ name, avatarUrl, size = 14 }: { name?: string; avatarUrl?: string | null; size?: number }) {
  const config = parseAvatarUrl(avatarUrl);
  if (config) return <AvatarRenderer config={config} size={size} className="rounded-full shrink-0" />;
  return (
    <span
      className="flex items-center justify-center rounded-full bg-secondary text-[8px] font-medium shrink-0"
      style={{ width: size, height: size }}
    >
      {(name ?? "?").charAt(0).toUpperCase()}
    </span>
  );
}

function TraceRow({ trace, slug }: { trace: TraceListItem; slug: string }) {
  const duration = formatDuration(trace.started_at, trace.completed_at);
  const statusLabel = trace.status === "active" ? "Active" : trace.status === "failed" ? "Failed" : "Completed";

  return (
    <Link
      href={`/w/${slug}/threads/${trace.trace_id}`}
      className="block px-4 py-3 border-b border-border/30 hover:bg-accent/30 transition-colors duration-150 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={trace.root_agent?.name} avatarUrl={trace.root_agent?.avatarUrl} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-foreground truncate flex-1 min-w-0">
              {trace.root_prompt.split("\n")[0]}
            </span>
            <span className="text-xs text-muted-foreground shrink-0 ml-2" title={new Date(trace.started_at).toLocaleString()}>
              {relativeTime(trace.started_at)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {trace.root_agent?.name && (
              <>
                <span className="text-xs font-medium text-muted-foreground">{trace.root_agent.name}</span>
                <span className="text-muted-foreground/40">&middot;</span>
              </>
            )}
            <span className="text-xs text-muted-foreground">#{trace.channel}</span>
            <span className="text-muted-foreground/40">&middot;</span>
            <StatusDot status={trace.status} />
            <span className="text-xs text-muted-foreground">{statusLabel}</span>
            {duration && (
              <>
                <span className="text-muted-foreground/40">&middot;</span>
                <span className="text-xs text-muted-foreground">{duration}</span>
              </>
            )}
            {trace.helper_agents.length > 0 && (
              <>
                <span className="text-muted-foreground/40">&middot;</span>
                <span className="flex items-center">
                  {trace.helper_agents.map((h, i) => (
                    <span key={h.id} className={i > 0 ? "-ml-1" : ""}>
                      <AgentAvatar name={h.name} avatarUrl={h.avatarUrl} />
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function SkeletonRow({ promptWidth }: { promptWidth: string }) {
  return (
    <div className="px-4 py-3 border-b border-border/30">
      <div className="flex items-center gap-2">
        <Skeleton className="h-3.5 w-4 rounded-full shrink-0" />
        <Skeleton className="h-3.5 rounded" style={{ width: promptWidth }} />
        <Skeleton className="h-2.5 w-10 rounded shrink-0 ml-auto" />
      </div>
      <div className="flex items-center gap-1.5 mt-1 ml-5.5">
        <Skeleton className="h-2.5 w-20 rounded-full" />
        <Skeleton className="h-2.5 w-8 rounded" />
      </div>
    </div>
  );
}

export default function TracesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { slug, workspaceId } = useWorkspace();
  const { channels } = useChannel();

  const [traces, setTraces] = useState<TraceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);

  const statusFilter = searchParams.get("status") ?? "active";
  const agentFilter = searchParams.get("agentId") ?? "";
  const channelFilter = searchParams.get("channel") ?? "";

  useEffect(() => {
    listAgents(workspaceId).then(setAgents).catch(() => {});
  }, [workspaceId]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listTraces(workspaceId, {
        limit: TRACE_LIMIT,
        status: statusFilter === "all" ? undefined : statusFilter || undefined,
        multiAgent: true,
        agentId: agentFilter || undefined,
        channel: channelFilter || undefined,
      });
      const seen = new Set<string>();
      const deduped = result.traces.filter((t) => {
        if (seen.has(t.trace_id)) return false;
        seen.add(t.trace_id);
        return true;
      });
      setTraces(deduped);
      setHasMore(result.has_more);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [workspaceId, statusFilter, agentFilter, channelFilter]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const loadOlderTraces = useCallback(async () => {
    if (isFetchingRef.current || !hasMore || traces.length === 0) return;
    isFetchingRef.current = true;
    setLoadingMore(true);
    try {
      const oldest = traces[traces.length - 1];
      const result = await listTraces(workspaceId, {
        limit: TRACE_LIMIT,
        before: oldest.started_at,
        status: statusFilter === "all" ? undefined : statusFilter || undefined,
        multiAgent: true,
        agentId: agentFilter || undefined,
        channel: channelFilter || undefined,
      });
      if (result.traces.length === 0) {
        setHasMore(false);
        return;
      }
      setHasMore(result.has_more);
      setTraces((prev) => {
        const existingIds = new Set(prev.map((t) => t.trace_id));
        const unique = result.traces.filter((t) => {
          if (existingIds.has(t.trace_id)) return false;
          existingIds.add(t.trace_id);
          return true;
        });
        return [...prev, ...unique];
      });
    } finally {
      isFetchingRef.current = false;
      setLoadingMore(false);
    }
  }, [workspaceId, traces, hasMore, statusFilter, agentFilter, channelFilter]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!loadingMore && hasMore && nearBottom) {
      loadOlderTraces();
    }
  }, [loadOlderTraces, loadingMore, hasMore]);

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const newParams = new URLSearchParams(searchParams.toString());
      if (value) {
        newParams.set(key, value);
      } else {
        newParams.delete(key);
      }
      const pathname = `/w/${slug}/threads`;
      const qs = newParams.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, slug, searchParams]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border/50 px-3 md:px-5 py-2.5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Threads</h1>
          <p className="text-xs text-muted-foreground hidden md:block">
            Execution traces across your agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadInitial}
            className="p-1.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-2">
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

        <Select value={agentFilter} onValueChange={(v) => updateFilter("agentId", v ?? "")}>
          <SelectTrigger className="w-40 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            {agentFilter ? agents.find((a) => a.id === agentFilter)?.name ?? agentFilter : "Agent: All"}
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">Agent: All</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex items-center gap-1.5">
                  <AgentAvatar name={a.name} avatarUrl={a.avatar_url} />
                  {a.name}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        <Select value={channelFilter} onValueChange={(v) => updateFilter("channel", v ?? "")}>
          <SelectTrigger className="w-40 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <SelectValue placeholder="Channel: All" />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">Channel: All</SelectItem>
            {channels.map((ch) => (
              <SelectItem key={ch.id} value={ch.name}>
                #{ch.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto thin-scrollbar"
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex flex-col">
            <SkeletonRow promptWidth="40%" />
            <SkeletonRow promptWidth="55%" />
            <SkeletonRow promptWidth="48%" />
          </div>
        ) : traces.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
            <GitBranch className="size-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No threads yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Only tasks involving multiple agents appear here.
            </p>
            {(statusFilter || agentFilter || channelFilter) && (
              <p className="text-xs text-muted-foreground/60 mt-1">
                Try changing your filter
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col animate-[fade-up_400ms_ease-out_both]">
            {traces.map((trace) => (
              <TraceRow key={trace.trace_id} trace={trace} slug={slug} />
            ))}
            {loadingMore && (
              <>
                <SkeletonRow promptWidth="48%" />
                <SkeletonRow promptWidth="40%" />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
