"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Mail, MessageSquare } from "lucide-react";
import { badgeVariants } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listAgentActiveTasks, type ActiveTask } from "@/lib/api";
import { useWorkspace } from "@/contexts/workspace-context";

interface AgentStatusBadgeProps {
  isOnline: boolean;
  taskCount: number;
  agentId: string;
}

const TASK_TYPES = [
  { type: "user_dm_message", icon: MessageSquare, label: "Chat" },
  { type: "email_notification", icon: Mail, label: "Email" },
  { type: "calendar_event", icon: CalendarDays, label: "Calendar" },
] as const;

function getTaskRoute(slug: string, agentId: string, type: string) {
  switch (type) {
    case "email_notification":
      return `/w/${slug}/agents/${agentId}/email`;
    case "calendar_event":
      return `/w/${slug}/calendar?agents=${agentId}`;
    default:
      return `/w/${slug}/agents/${agentId}`;
  }
}

function StatusDot({ online, pulse }: { online: boolean; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "size-1.5 rounded-full shrink-0",
        online ? "bg-status-online" : "bg-status-offline",
        pulse && "animate-pulse"
      )}
    />
  );
}

function groupByType(tasks: ActiveTask[]) {
  const map: Record<string, { total: number; running: number }> = {};
  for (const t of tasks) {
    const entry = map[t.type] ?? (map[t.type] = { total: 0, running: 0 });
    entry.total++;
    if (t.status === "running") entry.running++;
  }
  return map;
}

const badgeBase = "gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer";

export function AgentStatusBadge({ isOnline, taskCount, agentId }: AgentStatusBadgeProps) {
  const { slug, workspaceId } = useWorkspace();
  const router = useRouter();
  const [tasks, setTasks] = useState<ActiveTask[] | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [error, setError] = useState(false);

  const fetchTasks = useCallback(async () => {
    setTasks(null);
    setLoadingTasks(true);
    setError(false);
    try {
      const res = await listAgentActiveTasks(agentId, workspaceId);
      setTasks(res.tasks);
    } catch {
      setError(true);
    } finally {
      setLoadingTasks(false);
    }
  }, [agentId, workspaceId]);

  const grouped = useMemo(() => (tasks ? groupByType(tasks) : null), [tasks]);

  if (!isOnline) {
    return (
      <Badge
        variant="outline"
        render={<Link href={`/w/${slug}/runtimes`} title="Runtime offline — click to manage runtimes" />}
        className={badgeBase}
      >
        <StatusDot online={false} />
        <span className="hidden sm:inline">Offline</span>
      </Badge>
    );
  }

  return (
    <Popover onOpenChange={(open) => { if (open) fetchTasks(); }}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(badgeVariants({ variant: "outline" }), badgeBase)}
          />
        }
      >
        <StatusDot online pulse={taskCount > 0} />
        {taskCount > 0 ? (
          <>
            <span className="hidden sm:inline">Working</span>
            <span className="tabular-nums">{taskCount}</span>
          </>
        ) : (
          <span className="hidden sm:inline">Online</span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0">
        {loadingTasks ? (
          <div className="p-2 space-y-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5 px-2">
                <Skeleton className="size-3.5 rounded" />
                <Skeleton className="h-3 w-12" />
                <div className="flex-1" />
                <Skeleton className="h-3 w-6" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-muted-foreground">Failed to load</div>
        ) : !tasks || tasks.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">No active tasks</div>
        ) : (
          <div className="py-1">
            {TASK_TYPES.map(({ type, icon: Icon, label }) => {
              const entry = grouped?.[type];
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => router.push(getTaskRoute(slug, agentId, type))}
                  className="flex items-center gap-2 w-full py-1.5 px-2 text-left hover:bg-muted rounded-md transition-colors cursor-pointer"
                >
                  <Icon className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs flex-1">{label}</span>
                  {entry ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                      {entry.running > 0 && (
                        <span className="size-1.5 rounded-full bg-status-online animate-pulse" />
                      )}
                      {entry.running > 0 ? entry.running : entry.total}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/40">0</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
