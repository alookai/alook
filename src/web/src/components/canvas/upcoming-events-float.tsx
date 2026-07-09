"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CalendarDays, X } from "lucide-react";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import { listCalendarEvents } from "@/lib/api";
import type { CalendarEvent } from "@alook/shared";

function AgentAvatar({ name, avatarUrl, size = 20 }: { name?: string; avatarUrl?: string | null; size?: number }) {
  const config = parseAvatarUrl(avatarUrl);
  if (config) return <AvatarRenderer config={config} size={size} className="rounded-full shrink-0" />;
  return (
    <span
      className="flex items-center justify-center rounded-full bg-secondary text-[7px] font-medium shrink-0"
      style={{ width: size, height: size }}
    >
      {(name ?? "?").charAt(0).toUpperCase()}
    </span>
  );
}

interface AgentEventSummary {
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
  count: number;
}

export function UpcomingEventsFloat() {
  const { agents } = useAgentContext();
  const { slug, workspaceId } = useWorkspace();
  const isMobile = useIsMobile();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [expanded, setExpanded] = useState(false);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const fetchEvents = useCallback(async () => {
    if (!workspaceId) return;
    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);
    try {
      const data = await listCalendarEvents(workspaceId, {
        from: now.toISOString(),
        to: todayEnd.toISOString(),
      });
      const upcoming = data.filter((e) => new Date(e.occurrence_at) >= now);
      setEvents(upcoming);
    } catch {
      // silently ignore
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, 60_000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  const count = events.reduce((sum, e) => sum + (e.collapsed_count ?? 1), 0);

  if (isMobile || count === 0) return null;

  // Group events by agent
  const agentSummaries: AgentEventSummary[] = [];
  const countByAgent = new Map<string, number>();
  for (const e of events) {
    countByAgent.set(e.agent_id, (countByAgent.get(e.agent_id) ?? 0) + (e.collapsed_count ?? 1));
  }
  for (const [agentId, eventCount] of countByAgent) {
    const agent = agentMap.get(agentId);
    agentSummaries.push({
      agentId,
      agentName: agent?.name ?? "Unknown",
      avatarUrl: agent?.avatar_url ?? null,
      count: eventCount,
    });
  }
  agentSummaries.sort((a, b) => b.count - a.count);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex items-center gap-2 px-2 py-1 rounded-full bg-background/90 backdrop-blur-sm ring-1 ring-foreground/8 shadow-sm text-xs font-medium text-muted-foreground hover:text-foreground transition-colors animate-[fade-up_300ms_ease-out_both]"
      >
        <CalendarDays className="size-3" />
        {count} upcoming
      </button>
    );
  }

  return (
    <div
      role="region"
      aria-label="Upcoming events"
      className="w-72 rounded-lg ring-1 ring-foreground/8 shadow-sm bg-background/90 backdrop-blur-sm animate-[fade-up_300ms_ease-out_both]"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays className="size-3.5 text-muted-foreground" />
          <span>{count} events today</span>
        </div>
        <button
          type="button"
          aria-label="Collapse events panel"
          className="size-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => setExpanded(false)}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="max-h-52 overflow-y-auto thin-scrollbar py-1">
        {agentSummaries.map((summary) => (
          <Link
            key={summary.agentId}
            href={`/w/${slug}/calendar`}
            className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
          >
            <AgentAvatar name={summary.agentName} avatarUrl={summary.avatarUrl} size={22} />
            <span className="flex-1 text-sm truncate">{summary.agentName}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {summary.count} event{summary.count !== 1 ? "s" : ""}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
