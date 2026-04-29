"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MessageSquare, Mail, CalendarDays, RotateCw, Loader2 } from "lucide-react";
import { retryTask, type WorkspaceOverview } from "@/lib/api";
import type { Agent } from "@alook/shared";

interface RecentActivityProps {
  overview: WorkspaceOverview;
  agents: Agent[];
  workspaceId: string;
  onRefresh: () => void;
}

const TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string }> = {
  user_dm_message: { icon: MessageSquare, label: "Chat message" },
  email_notification: { icon: Mail, label: "Email task" },
  calendar_event: { icon: CalendarDays, label: "Calendar event" },
};

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RecentActivity({ overview, agents, workspaceId, onRefresh }: RecentActivityProps) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const { recent_tasks } = overview;
  const agentMap = new Map(agents.map((a) => [a.id, a.name]));

  if (recent_tasks.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center py-4 text-muted-foreground">
            <MessageSquare className="size-8 opacity-20 mb-2" />
            <p className="text-sm">No recent activity</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0 overflow-y-auto thin-scrollbar">
        <div className="divide-y divide-border/50">
          {recent_tasks.map((task) => {
            const config = TYPE_CONFIG[task.type] ?? TYPE_CONFIG.user_dm_message;
            const Icon = config.icon;
            return (
              <div key={task.id} className="flex items-center gap-3 px-4 py-2.5">
                <Tooltip>
                  <TooltipTrigger render={
                    <span className="flex items-center">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    </span>
                  } />
                  <TooltipContent side="top">{config.label}</TooltipContent>
                </Tooltip>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium shrink-0">
                      {agentMap.get(task.agent_id) ?? "Unknown"}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {task.prompt.slice(0, 80)}{task.prompt.length > 80 ? "..." : ""}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant={task.status === "completed" ? "secondary" : "destructive"}
                    className="text-[10px] px-1.5 py-0"
                  >
                    {task.status}
                  </Badge>
                  {task.status === "failed" && (
                    <button
                      type="button"
                      onClick={async () => {
                        setRetryingId(task.id);
                        try {
                          await retryTask(task.id, workspaceId);
                          onRefresh();
                        } catch { /* silently fail */ }
                        finally { setRetryingId(null); }
                      }}
                      disabled={retryingId === task.id}
                      className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
                      title="Retry task"
                    >
                      {retryingId === task.id
                        ? <Loader2 className="size-3 animate-spin" />
                        : <RotateCw className="size-3" />}
                    </button>
                  )}
                  <span className="text-[10px] text-muted-foreground w-14 text-right">
                    {timeAgo(task.completed_at)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
