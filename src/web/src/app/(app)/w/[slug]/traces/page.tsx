"use client";

import { useObservedQueryRegion } from "@/lib/observability/query-regions"

import { useCallback, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { workspaceTracesOptions } from "@/hooks/workspace/trace-query-options";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWorkspaceOwner } from "@/contexts/workspace-context";
import { useChannel } from "@/contexts/channel-context";
import type { TraceListItem } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { GitBranch, RefreshCw } from "lucide-react";
import { AgentAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

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

function TraceRow({ trace, slug }: { trace: TraceListItem; slug: string }) {
  const duration = formatDuration(trace.started_at, trace.completed_at);
  const statusLabel = trace.status === "active" ? "Active" : trace.status === "failed" ? "Failed" : "Completed";

  return (
    <Link
      href={`/w/${slug}/traces/${trace.trace_id}`}
      className="block px-4 py-3 border-b border-border/30 hover:bg-accent/30 transition-colors duration-150 cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <AgentAvatar name={trace.root_agent?.name} avatarUrl={trace.root_agent?.avatarUrl} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-foreground truncate flex-1 min-w-0">
              {trace.root_prompt.split("\n")[0]}
            </span>
            <Tooltip>
              <TooltipTrigger render={<span className="text-xs text-muted-foreground shrink-0 ml-2" />}>
                {relativeTime(trace.started_at)}
              </TooltipTrigger>
              <TooltipContent>{new Date(trace.started_at).toLocaleString()}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-2">
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
                      <AgentAvatar name={h.name} avatarUrl={h.avatarUrl} seed={h.id} />
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
      <div className="flex items-center gap-2 mt-1 ml-6">
        <Skeleton className="h-2.5 w-20 rounded-full" />
        <Skeleton className="h-2.5 w-8 rounded" />
      </div>
    </div>
  );
}

export default function TracesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const owner = useWorkspaceOwner();
  const { slug } = owner;
  const { channels } = useChannel();
  const { agents } = useAgentContext();
  const scrollRef = useRef<HTMLDivElement>(null);
  const statusFilter = searchParams.get("status") ?? "active";
  const agentFilter = searchParams.get("agentId") ?? "";
  const channelFilter = searchParams.get("channel") ?? "";
  const source = useWorkspaceViewSource(owner, JSON.stringify([statusFilter, agentFilter, channelFilter]), true);
  const resource = useInfiniteQuery(workspaceTracesOptions(owner, { status: statusFilter, agentId: agentFilter, channel: channelFilter }));
  const seen = new Set<string>();
  const traces = (resource.data?.pages ?? []).flatMap((page) => page.traces).filter((trace) => {
    if (seen.has(trace.trace_id)) return false;
    seen.add(trace.trace_id); return true;
  });
  const loading = resource.isPending;
  useObservedQueryRegion("traces", resource, traces.length);
  const hasMore = resource.hasNextPage;
  const loadingMore = resource.isFetchingNextPage;
  const loadInitial = async () => {
    try { source.assertActive(); await resource.refetch(); } catch {}
  };
  const loadOlderTraces = async () => {
    try { source.assertActive(); await resource.fetchNextPage({ cancelRefetch: false }); } catch {}
  };
  const handleScroll = () => {
    const el = scrollRef.current;
    if (el && !loadingMore && hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadOlderTraces();
  };

  const updateFilter = useCallback(
    (key: string, value: string) => {
      const newParams = new URLSearchParams(searchParams.toString());
      if (value) {
        newParams.set(key, value);
      } else {
        newParams.delete(key);
      }
      const pathname = `/w/${slug}/traces`;
      const qs = newParams.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, slug, searchParams]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-border/50 px-3 sm:px-4 py-2 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-medium">Traces</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">
            Execution traces across your agents.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={loadInitial}
                  className="text-muted-foreground"
                />
              }
            >
              <RefreshCw className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-2">
        <Select value={statusFilter} onValueChange={(v) => updateFilter("status", v ?? "")}>
          <SelectTrigger className="w-35 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <SelectValue placeholder="Status: All" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label === "All" ? "Status: All" : opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={agentFilter} onValueChange={(v) => updateFilter("agentId", v ?? "")}>
          <SelectTrigger className="w-40 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            {agentFilter ? agents.find((a) => a.id === agentFilter)?.name ?? agentFilter : "Agent: All"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Agent: All</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex items-center gap-2">
                  <AgentAvatar name={a.name} avatarUrl={a.avatar_url} seed={a.id} />
                  {a.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={channelFilter} onValueChange={(v) => updateFilter("channel", v ?? "")}>
          <SelectTrigger className="w-40 border-none bg-transparent shadow-none text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            <SelectValue placeholder="Channel: All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Channel: All</SelectItem>
            {channels.map((ch) => (
              <SelectItem key={ch.id} value={ch.name}>
                #{ch.name}
              </SelectItem>
            ))}
          </SelectContent>
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
            <p className="text-sm text-muted-foreground">No traces yet</p>
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
