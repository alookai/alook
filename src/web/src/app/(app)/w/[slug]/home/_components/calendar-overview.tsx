"use client";

import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { useWorkspace } from "@/contexts/workspace-context";
import { CalendarDays, ArrowUpRight, Repeat } from "lucide-react";
import type { WorkspaceOverview } from "@/lib/api";
import type { Agent } from "@alook/shared";

interface CalendarOverviewProps {
  overview: WorkspaceOverview;
  agents: Agent[];
}

function formatRepeatInterval(interval: string): string {
  const match = interval.match(/^(\d+)(min|hour|day|week|month)$/);
  if (!match) return interval;
  const [, n, unit] = match;
  const num = Number(n);
  const labels: Record<string, string> = { min: "min", hour: "hour", day: "day", week: "week", month: "month" };
  const label = labels[unit] ?? unit;
  return num === 1 ? `Every ${label}` : `Every ${num} ${label}s`;
}

export function CalendarOverview({ overview, agents }: CalendarOverviewProps) {
  const router = useRouter();
  const { slug } = useWorkspace();
  const { calendar_events } = overview;
  const agentMap = new Map(agents.map((a) => [a.id, a.name]));

  const now = new Date();
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const todayEvents = calendar_events.filter(
    (e) => new Date(e.scheduled_at) <= todayEnd
  );

  const recurring = calendar_events.filter((e) => e.repeat_interval);
  const oneOff = calendar_events.filter((e) => !e.repeat_interval);

  const upcoming = [...calendar_events]
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    .slice(0, 5);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Calendar</CardTitle>
        <CardAction>
          <button
            type="button"
            onClick={() => router.push(`/w/${slug}/calendar`)}
            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <ArrowUpRight className="size-4" />
          </button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3 flex-1 min-h-0 overflow-y-auto thin-scrollbar">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border/50 px-3 py-2 text-center">
            <p className="text-xl font-semibold">{todayEvents.length}</p>
            <p className="text-[10px] text-muted-foreground">Today</p>
          </div>
          <div className="rounded-lg border border-border/50 px-3 py-2 text-center">
            <p className="text-xl font-semibold">{recurring.length}</p>
            <p className="text-[10px] text-muted-foreground">Recurring</p>
          </div>
          <div className="rounded-lg border border-border/50 px-3 py-2 text-center">
            <p className="text-xl font-semibold">{oneOff.length}</p>
            <p className="text-[10px] text-muted-foreground">One-off</p>
          </div>
        </div>

        {upcoming.length > 0 && (
          <div className="space-y-1.5 pt-2 border-t border-border/50">
            <p className="text-xs font-medium text-muted-foreground">Upcoming This Week</p>
            {upcoming.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-xs">
                {e.repeat_interval ? (
                  <Repeat className="size-3 shrink-0 text-primary" />
                ) : (
                  <CalendarDays className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate flex-1">{e.title}</span>
                <span className="text-muted-foreground shrink-0">
                  {agentMap.get(e.agent_id) ?? "—"}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {e.repeat_interval
                    ? `${formatRepeatInterval(e.repeat_interval)}, ${new Date(e.scheduled_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                    : new Date(e.scheduled_at).toLocaleDateString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        )}

        {calendar_events.length === 0 && (
          <div className="flex flex-col items-center py-4 text-muted-foreground">
            <CalendarDays className="size-8 opacity-20 mb-2" />
            <p className="text-sm">No events this week</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
