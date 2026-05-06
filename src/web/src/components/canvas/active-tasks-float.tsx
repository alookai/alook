"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { X, Minus } from "lucide-react";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import type { WorkspaceActiveTask } from "@/lib/api";

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

function TaskRow({ task, slug }: { task: WorkspaceActiveTask; slug: string }) {
  const isRunning = task.status === "running";

  return (
    <Link
      href={`/w/${slug}/agents/${task.agent_id}?task=${task.id}&conv=${task.conversation_id}`}
      className="flex items-center gap-2.5 px-3 py-2 hover:bg-accent/50 transition-colors cursor-pointer rounded-md"
    >
      <div className="relative shrink-0">
        <AgentAvatar name={task.agent?.name} avatarUrl={task.agent?.avatarUrl} size={24} />
        <span
          className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background ${
            isRunning ? "bg-primary animate-pulse" : "bg-muted-foreground/40"
          }`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 leading-tight">
          <span className="text-sm font-medium truncate">
            {task.agent?.name ?? "Unknown"}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            #{task.channel}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate leading-tight">
          {task.prompt}
        </p>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
        {relativeTime(task.created_at)}
      </span>
    </Link>
  );
}

export function ActiveTasksFloat() {
  const { activeTaskDetails } = useAgentContext();
  const { slug } = useWorkspace();
  const isMobile = useIsMobile();
  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const prevTaskIdsRef = useRef<Set<string>>(new Set());

  const tasks = activeTaskDetails;
  const taskCount = tasks.length;

  useEffect(() => {
    if (taskCount === 0) {
      prevTaskIdsRef.current = new Set();
      return;
    }
    const currentIds = new Set(tasks.map((t) => t.id));
    const hasNewTask = tasks.some((t) => !prevTaskIdsRef.current.has(t.id));
    if (hasNewTask && dismissed) {
      setDismissed(false);
    }
    prevTaskIdsRef.current = currentIds;
  }, [tasks, taskCount, dismissed]);

  if (isMobile || taskCount === 0) return null;

  if (dismissed) {
    return (
      <button
        type="button"
        onClick={() => setDismissed(false)}
        className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-background/90 backdrop-blur-sm ring-1 ring-foreground/8 shadow-sm text-xs font-medium text-muted-foreground hover:text-foreground transition-colors animate-[fade-up_300ms_ease-out_both]"
      >
        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
        {taskCount} active
      </button>
    );
  }

  return (
    <div
      role="region"
      aria-label="Active tasks"
      className="absolute bottom-4 right-4 z-10 w-80 rounded-lg ring-1 ring-foreground/8 shadow-sm bg-background/90 backdrop-blur-sm animate-[fade-up_300ms_ease-out_both]"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
          <span className="size-1.5 rounded-full bg-primary animate-pulse" />
          <span>
            {taskCount} task{taskCount !== 1 ? "s" : ""} active
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={minimized ? "Expand tasks" : "Minimize tasks"}
            className="size-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            onClick={() => setMinimized((v) => !v)}
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close tasks panel"
            className="size-6 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            onClick={() => setDismissed(true)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {!minimized && (
        <div className="max-h-75 overflow-y-auto thin-scrollbar py-1">
          {tasks.slice(0, 8).map((task) => (
            <TaskRow key={task.id} task={task} slug={slug} />
          ))}
          {taskCount > 8 && (
            <Link
              href={`/w/${slug}/threads?status=active`}
              className="block text-xs text-muted-foreground hover:text-foreground text-center py-1.5 transition-colors"
            >
              View all {taskCount} tasks
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
