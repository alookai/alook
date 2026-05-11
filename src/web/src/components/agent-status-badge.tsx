"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { badgeVariants } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listWorkspaceActiveTasks, type WorkspaceActiveTask } from "@/lib/api";
import { useWorkspace } from "@/contexts/workspace-context";
import { relativeTime } from "@/lib/time";

interface AgentStatusBadgeProps {
  isOnline: boolean;
  taskCount: number;
  agentId: string;
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "size-1.5 rounded-full shrink-0",
        online ? "bg-status-online" : "bg-status-offline"
      )}
    />
  );
}

function taskDisplayTitle(prompt: string): string {
  const match = prompt.match(/^Issue\s+iss_\w+:\s*(.+)/);
  if (match) return match[1].split("\n")[0];
  return prompt.split("\n")[0];
}

function TaskRow({ task, slug, agentId }: { task: WorkspaceActiveTask; slug: string; agentId: string }) {
  const isRunning = task.status === "running";
  return (
    <Link
      href={`/w/${slug}/agents/${agentId}?task=${task.id}&conv=${task.conversation_id}`}
      className="flex items-center gap-2 w-full py-1.5 px-2 hover:bg-muted rounded-md transition-colors cursor-pointer"
    >
      <span
        className={cn(
          "size-1.5 rounded-full shrink-0",
          isRunning ? "bg-primary animate-pulse" : "bg-muted-foreground/40"
        )}
      />
      <div className="flex-1 min-w-0">
        <p className="text-xs truncate">{taskDisplayTitle(task.prompt)}</p>
      </div>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
        {relativeTime(task.created_at)}
      </span>
    </Link>
  );
}

const MAX_VISIBLE_TASKS = 6;
const badgeBase = "gap-1.5 text-muted-foreground hover:text-foreground cursor-pointer";

export function AgentStatusBadge({ isOnline, taskCount, agentId }: AgentStatusBadgeProps) {
  const { slug, workspaceId } = useWorkspace();
  const [tasks, setTasks] = useState<WorkspaceActiveTask[] | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [error, setError] = useState(false);

  const fetchTasks = useCallback(async () => {
    setTasks(null);
    setLoadingTasks(true);
    setError(false);
    try {
      const res = await listWorkspaceActiveTasks(workspaceId);
      setTasks(res.tasks.filter((t) => t.agent_id === agentId));
    } catch {
      setError(true);
    } finally {
      setLoadingTasks(false);
    }
  }, [agentId, workspaceId]);

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
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          />
        }
      >
        <StatusDot online />
        {taskCount > 0 ? (
          <>
            <span className="hidden sm:inline">Working</span>
            <span className="tabular-nums">{taskCount}</span>
          </>
        ) : (
          <span className="hidden sm:inline">Online</span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-1">
        {loadingTasks ? (
          <div className="p-2 space-y-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5 px-2">
                <Skeleton className="size-1.5 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-2.5 w-10" />
                  <Skeleton className="h-3 w-full" />
                </div>
                <Skeleton className="h-2.5 w-8" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-muted-foreground">Failed to load</div>
        ) : !tasks || tasks.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">No active tasks</div>
        ) : (
          <div className="max-h-75 overflow-y-auto">
            {tasks.slice(0, MAX_VISIBLE_TASKS).map((task) => (
              <TaskRow key={task.id} task={task} slug={slug} agentId={agentId} />
            ))}
            {tasks.length > MAX_VISIBLE_TASKS && (
              <Link
                href={`/w/${slug}/agents/${agentId}/activity?status=running`}
                className="block text-xs text-muted-foreground hover:text-foreground text-center py-1.5 transition-colors"
              >
                View all {tasks.length} tasks
              </Link>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
