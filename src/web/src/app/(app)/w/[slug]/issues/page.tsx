"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { CircleDot, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import type { Agent, Artifact, Issue, IssueComment, Message, WsMessage } from "@alook/shared";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { createIssue, deleteIssue, getIssue, getTask, getTrace, listIssues, updateIssue } from "@/lib/api";
import type { IssueListItem, TraceTask } from "@/lib/api";
import type { TaskApi } from "@alook/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, useDraggable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { IssueSheet } from "@/components/issues/issue-sheet";
import { trackIssueCreated, trackIssueStatusChanged } from "@/lib/analytics";
import { ArtifactSheet } from "@/components/agent-chat/artifact-sheet";
import { isPreviewable, getArtifactUrl, computeArtifactVersions } from "@/components/artifact-content-renderer";


const COLUMNS = [
  { id: "todo", label: "Todo", statuses: ["todo"] },
  { id: "in_progress", label: "In Progress", statuses: ["in_progress"] },
  { id: "review", label: "Review", statuses: ["review"] },
  { id: "completed", label: "Completed", statuses: ["done", "closed", "canceled", "failed"] },
] as const;

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function AgentAvatar({ agent, size = 24 }: { agent?: Agent | null; size?: number }) {
  const avatarConfig = parseAvatarUrl(agent?.avatar_url);
  if (avatarConfig) {
    return <AvatarRenderer config={avatarConfig} size={size} className="shrink-0 rounded-full" />;
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-medium text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {(agent?.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

function IssueCard({
  issue,
  selected,
  onClick,
  onDelete,
  agent,
  agentsById,
  compact = false,
}: {
  issue: IssueListItem;
  selected: boolean;
  onClick: () => void;
  onDelete?: () => void;
  agent?: Agent | null;
  agentsById?: Map<string, Agent>;
  compact?: boolean;
}) {
  const threadAgents = useMemo(() => {
    const ids = issue.thread_agent_ids;
    if (!ids || ids.length < 2 || !agentsById) return null;
    const assignedId = issue.agent_id;
    const sorted = assignedId
      ? [assignedId, ...ids.filter(id => id !== assignedId)]
      : ids;
    return sorted.map(id => agentsById.get(id)).filter((a): a is Agent => !!a);
  }, [issue.thread_agent_ids, issue.agent_id, agentsById]);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "w-full rounded-lg border bg-background/75 p-3 text-left transition-colors cursor-pointer",
              "hover:bg-accent/70 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              selected ? "border-foreground/30 bg-accent" : "border-border/60"
            )}
          />
        }
      >
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="line-clamp-2 min-w-0 text-sm font-medium leading-5 text-foreground">{issue.title}</div>
            {issue.status === "in_progress" && (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <Loader2 className="size-2.5 animate-spin" /> Working
              </span>
            )}
            {issue.status === "review" && (
              <span className="shrink-0 rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">Review</span>
            )}
            {issue.status === "failed" && (
              <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">Failed</span>
            )}
          </div>
          {issue.description ? (
            <div className={cn("mt-1 text-xs leading-4 text-muted-foreground", compact ? "line-clamp-1" : "line-clamp-2")}>
              {issue.description}
            </div>
          ) : null}
          <div className="mt-2 flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
            {threadAgents && threadAgents.length >= 2 ? (
              <span className="flex items-center">
                {threadAgents.slice(0, 3).map((a, i) => (
                  <span key={a.id} className={cn("rounded-full border-2 border-background", i > 0 && "-ml-1.5")}>
                    <AgentAvatar agent={a} size={16} />
                  </span>
                ))}
                {threadAgents.length > 3 && (
                  <span className="flex items-center justify-center rounded-full border-2 border-background bg-muted text-[9px] font-medium text-muted-foreground -ml-1.5" style={{ width: 16, height: 16 }}>
                    +{threadAgents.length - 3}
                  </span>
                )}
              </span>
            ) : agent ? (
              <span className="flex items-center gap-1 truncate">
                <AgentAvatar agent={agent} size={14} />
                <span className="truncate">{agent.name}</span>
              </span>
            ) : (
              <span className="truncate text-muted-foreground/60">{issue.agent_id ? "" : "Unassigned"}</span>
            )}
            <span className="shrink-0">{formatDate(issue.updated_at)}</span>
          </div>
        </div>
      </ContextMenuTrigger>
      {onDelete && (
        <ContextMenuContent>
          <ContextMenuItem className="text-destructive" onClick={onDelete}>
            <Trash2 className="size-3.5 mr-1.5" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

function DroppableColumn({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-0 flex-col rounded-lg border bg-card/60 transition-colors",
        isOver ? "ring-2 ring-primary/40 bg-primary/5 border-primary/30" : "border-border/60",
        className
      )}
    >
      {children}
    </div>
  );
}

function CollapsedCompletedStrip({ activeDragId, completedCount, onExpand }: { activeDragId: string | null; completedCount: number; onExpand: () => void }) {
  const { isOver, setNodeRef } = useDroppable({ id: "completed" });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            ref={setNodeRef}
            role="button"
            tabIndex={0}
            aria-label="Show completed column"
            onClick={() => { if (!activeDragId) onExpand(); }}
            onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !activeDragId) { e.preventDefault(); onExpand(); } }}
            className={cn(
              "flex h-full items-center justify-center rounded-lg border transition-colors",
              isOver
                ? "ring-2 ring-primary/40 bg-primary/5 border-primary/30"
                : "border-dashed border-border/60 bg-muted/20 cursor-pointer hover:bg-muted/40"
            )}
          />
        }
      >
        <div className="flex flex-col items-center justify-center gap-3 h-full py-3">
          <Eye className="size-3.5 text-muted-foreground/60 shrink-0" />
          <span className="text-xs font-medium text-muted-foreground" style={{ writingMode: "vertical-rl" }}>
            Completed ({completedCount})
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{activeDragId ? "Drop to complete" : "Show completed"}</TooltipContent>
    </Tooltip>
  );
}

function DraggableIssueCard({
  issue,
  selected,
  onClick,
  onDelete,
  agent,
  agentsById,
  compact = false,
}: {
  issue: IssueListItem;
  selected: boolean;
  onClick: () => void;
  onDelete?: () => void;
  agent?: Agent | null;
  agentsById?: Map<string, Agent>;
  compact?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: issue.id });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
    cursor: isDragging ? "grabbing" : "grab",
  };

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <IssueCard issue={issue} selected={selected} onClick={onClick} onDelete={onDelete} agent={agent} agentsById={agentsById} compact={compact} />
    </div>
  );
}

export default function IssuesPage() {
  const { workspaceId, slug } = useWorkspace();
  const { agents, loading: agentsLoading, subscribeWs } = useAgentContext();
  const [recentAgentId, setRecentAgentId] = useLocalStorage<string>(`issue-recent-agent-id-${workspaceId}`, "");
  const [draft, setDraft] = useLocalStorage<{ title: string; description: string; agentId: string }>(`issue-draft-${workspaceId}`, { title: "", description: "", agentId: "" });
  const [showCompleted, setShowCompleted] = useLocalStorage<boolean>("issues-show-completed", true);
  const [issues, setIssues] = useState<IssueListItem[]>([]);
  const issuesRef = useRef<IssueListItem[]>([]);
  useEffect(() => { issuesRef.current = issues; });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ issue: Issue & { trace_id?: string | null }; messages: Message[]; comments: IssueComment[]; artifacts: Artifact[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTask, setActiveTask] = useState<TaskApi | null>(null);
  const [traceTasks, setTraceTasks] = useState<TraceTask[] | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [artifactSheetOpen, setArtifactSheetOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const pendingStatusUpdate = useRef<string | null>(null);
  const refreshSeqRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);

  const issueArtifacts = useMemo(() => detail?.artifacts ?? [], [detail?.artifacts]);
  const { versionMap: artifactVersionMap, duplicateFilenames: artifactDuplicateFilenames } = useMemo(
    () => computeArtifactVersions(issueArtifacts),
    [issueArtifacts],
  );

  const handleArtifactClick = useCallback((artifact: Artifact) => {
    if (isPreviewable(artifact)) {
      setSelectedArtifact(artifact);
      setArtifactSheetOpen(true);
    } else {
      window.open(getArtifactUrl(artifact.id, workspaceId, true), "_blank");
    }
  }, [workspaceId]);

  async function reload() {
    setLoading(true);
    try {
      const [active, completed] = await Promise.all([
        listIssues(workspaceId, { terminal: false }),
        listIssues(workspaceId, { terminal: true }),
      ]);
      setIssues([...active, ...completed]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load issues");
    } finally {
      setLoading(false);
    }
  }

  async function silentReload() {
    try {
      const [active, completed] = await Promise.all([
        listIssues(workspaceId, { terminal: false }),
        listIssues(workspaceId, { terminal: true }),
      ]);
      setIssues([...active, ...completed]);
    } catch {
      // silent — background refresh, errors are transient
    }
  }

  const silentReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsDetailRefreshRef = useRef(false);

  function debouncedSilentReload() {
    if (silentReloadTimerRef.current) clearTimeout(silentReloadTimerRef.current);
    silentReloadTimerRef.current = setTimeout(() => {
      silentReloadTimerRef.current = null;
      silentReload().catch(() => {});
      if (needsDetailRefreshRef.current) {
        if (selectedIdRef.current) {
          refreshIssue(selectedIdRef.current).catch(() => {});
        }
        needsDetailRefreshRef.current = false;
      }
    }, 300);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function openIssue(issueId: string) {
    setSelectedId(issueId);
    selectedIdRef.current = issueId;
    setSheetOpen(true);
    setDetailLoading(true);
    setTraceTasks(null);
    try {
      const res = await getIssue(workspaceId, issueId);
      setDetail(res);
      if (res.issue.trace_id) {
        getTrace(res.issue.trace_id, workspaceId)
          .then(t => setTraceTasks(t.tasks))
          .catch(() => setTraceTasks(null));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load issue");
    } finally {
      setDetailLoading(false);
    }
  }

  async function refreshIssue(issueId: string) {
    const seq = ++refreshSeqRef.current;
    try {
      const res = await getIssue(workspaceId, issueId);
      if (seq !== refreshSeqRef.current || selectedIdRef.current !== issueId) return;
      setDetail(res);
      if (res.issue.trace_id) {
        getTrace(res.issue.trace_id, workspaceId)
          .then(t => { if (seq === refreshSeqRef.current && selectedIdRef.current === issueId) setTraceTasks(t.tasks); })
          .catch(() => {});
      }
      const taskId = res.issue.latest_task_id;
      if (taskId) {
        getTask(taskId, workspaceId)
          .then(task => { if (seq === refreshSeqRef.current && selectedIdRef.current === issueId) setActiveTask(task); })
          .catch(() => {});
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) {
        handleSheetOpenChange(false);
      }
    }
  }

  const detailConvId = detail?.issue.conversation_id ?? null;
  const detailConvIdRef = useRef<string | null>(null);
  useEffect(() => { detailConvIdRef.current = detailConvId; });
  const detailTaskId = detail?.issue.latest_task_id ?? null;
  const detailTaskIdRef = useRef<string | null>(null);
  useEffect(() => { detailTaskIdRef.current = detailTaskId; });
  const detailAgentId = detail?.issue.agent_id ?? null;
  const detailAgentIdRef = useRef<string | null>(null);
  useEffect(() => { detailAgentIdRef.current = detailAgentId; });

  useEffect(() => {
    if (!detailTaskId) { setActiveTask(null); return; }
    let cancelled = false;
    getTask(detailTaskId, workspaceId).then((task) => {
      if (!cancelled) setActiveTask(task);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [detailTaskId, workspaceId]);

  useEffect(() => {
    const unsub = subscribeWs((msg: WsMessage) => {
      if (msg.type === "conversation.message" && detailConvIdRef.current && msg.conversationId === detailConvIdRef.current) {
        setDetail((prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === msg.message.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg.message] };
        });
        if (msg.message.role === "event" && msg.message.content.startsWith("Issue status changed:") && !pendingStatusUpdate.current) {
          const match = msg.message.content.match(/-> (\w+)/);
          if (match) {
            const newStatus = match[1] as Issue["status"];
            setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: newStatus } } : prev);
            setIssues((prev) => prev.map((i) => i.conversation_id === detailConvIdRef.current ? { ...i, status: newStatus, updated_at: msg.message.created_at } : i));
          }
        }
      }
      if (msg.type === "conversation.message"
          && msg.message.role === "event"
          && msg.message.content.startsWith("Issue status changed:")
          && !pendingStatusUpdate.current
          && msg.conversationId !== detailConvIdRef.current) {
        const match = msg.message.content.match(/-> (\w+)/);
        if (match) {
          const newStatus = match[1] as Issue["status"];
          setIssues((prev) => prev.map((i) =>
            i.conversation_id === msg.conversationId
              ? { ...i, status: newStatus, updated_at: msg.message.created_at }
              : i
          ));
        }
      }
      if (msg.type === "issue.comment" && selectedIdRef.current === msg.issueId) {
        setDetail((prev) => {
          if (!prev) return prev;
          if (prev.comments.some((c) => c.id === msg.comment.id)) return prev;
          return { ...prev, comments: [...prev.comments, msg.comment] };
        });
      }
      if (msg.type === "task.updated" && (msg.status === "running" || msg.status === "completed" || msg.status === "failed")) {
        if (pendingStatusUpdate.current) return;

        const currentIssues = issuesRef.current;

        if (currentIssues.length === 0) {
          debouncedSilentReload();
          return;
        }

        const issueAgentIds = new Set(currentIssues.map(i => i.agent_id).filter((id): id is string => !!id));
        const issueTaskIds = new Set(currentIssues.map(i => i.latest_task_id).filter((id): id is string => !!id));

        if (!issueAgentIds.has(msg.agentId) && !issueTaskIds.has(msg.taskId)) return;

        if (msg.taskId === detailTaskIdRef.current || msg.agentId === detailAgentIdRef.current) {
          needsDetailRefreshRef.current = true;
        }

        debouncedSilentReload();
      }
    });
    return () => {
      unsub();
      if (silentReloadTimerRef.current) {
        clearTimeout(silentReloadTimerRef.current);
        silentReloadTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeWs]);

  // --- Sheet handlers ---

  const handleCreate = useCallback(async (values: { agent_id?: string; title: string; description: string }) => {
    setCreating(true);
    try {
      const res = await createIssue(workspaceId, {
        agent_id: values.agent_id,
        title: values.title,
        description: values.description,
      });
      trackIssueCreated({ agent_id: values.agent_id ?? "" });
      setIssues((prev) => [res.issue, ...prev]);
      if (values.agent_id) setRecentAgentId(values.agent_id);
      setDraft({ title: "", description: "", agentId: "" });
      setSelectedId(res.issue.id);
      selectedIdRef.current = res.issue.id;
      openIssue(res.issue.id);
      toast.success("Issue created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setCreating(false);
    }
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpdate = useCallback(async (issueId: string, patch: { title?: string; description?: string }) => {
    try {
      const updated = await updateIssue(workspaceId, issueId, patch);
      setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, ...patch, updated_at: updated.updated_at } : i));
      setDetail((prev) => prev && prev.issue.id === issueId ? { ...prev, issue: { ...prev.issue, ...patch, updated_at: updated.updated_at } } : prev);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update issue");
    }
  }, [workspaceId]);

  const handleStatusChange = useCallback(async (issueId: string, newStatus: string) => {
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;
    const oldStatus = issue.status;
    if (newStatus === oldStatus) return;

    trackIssueStatusChanged({ from: oldStatus, to: newStatus, method: "button" });

    const now = new Date().toISOString();
    setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, status: newStatus as Issue["status"], updated_at: now } : i));
    if (detail?.issue.id === issueId) {
      setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: newStatus as Issue["status"], updated_at: now } } : prev);
    }

    pendingStatusUpdate.current = issueId;
    try {
      await updateIssue(workspaceId, issueId, { status: newStatus as Issue["status"] });
    } catch (err) {
      setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, status: oldStatus } : i));
      if (detail?.issue.id === issueId) {
        setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: oldStatus } } : prev);
      }
      toast.error(err instanceof Error ? err.message : "Failed to update issue status");
    } finally {
      pendingStatusUpdate.current = null;
    }
  }, [workspaceId, issues, detail]);


  const handleDeleteIssue = useCallback(async (issueId: string) => {
    try {
      await deleteIssue(workspaceId, issueId);
      setIssues((prev) => prev.filter((i) => i.id !== issueId));
      if (selectedId === issueId) {
        setSelectedId(null);
        selectedIdRef.current = null;
        setSheetOpen(false);
        setDetail(null);
      }
      toast.success("Issue deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete issue");
    }
  }, [workspaceId, selectedId]);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      setSelectedId(null);
      selectedIdRef.current = null;
      setDetail(null);
      setActiveTask(null);
      setTraceTasks(null);
    }
  }, []);

  // --- DnD handlers ---

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(event.active.id as string);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const targetColId = over.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    const targetCol = COLUMNS.find((c) => c.id === targetColId);
    if (!targetCol) return;

    if ((targetCol.statuses as readonly string[]).includes(issue.status)) return;

    if (issue.status === "todo" && !issue.agent_id && targetColId !== "todo" && targetColId !== "completed") {
      toast.error("Assign an agent first to run this issue");
      return;
    }

    const newStatus = targetColId === "completed" ? "done" : targetColId;
    const oldStatus = issue.status;

    trackIssueStatusChanged({ from: oldStatus, to: newStatus, method: "drag" });

    const now = new Date().toISOString();
    setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, status: newStatus as Issue["status"], updated_at: now } : i));
    if (detail?.issue.id === issueId) {
      setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: newStatus as Issue["status"], updated_at: now } } : prev);
    }

    pendingStatusUpdate.current = issueId;
    try {
      await updateIssue(workspaceId, issueId, { status: newStatus as Issue["status"] });
    } catch (err) {
      setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, status: oldStatus } : i));
      if (detail?.issue.id === issueId) {
        setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: oldStatus } } : prev);
      }
      toast.error(err instanceof Error ? err.message : "Failed to update issue status");
    } finally {
      pendingStatusUpdate.current = null;
    }
  }

  const boardLoading = loading || agentsLoading;
  const selectedIssue = selectedId ? issues.find((i) => i.id === selectedId) ?? null : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background/30">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-normal">Issues</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="w-full sm:w-auto" onClick={() => { setSelectedId(null); selectedIdRef.current = null; setSheetOpen(true); }}>
            <Plus className="size-4" />
            New issue
          </Button>
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 lg:block overflow-y-auto thin-scrollbar p-4">
        {boardLoading ? (
          <div className={cn("grid h-full gap-4", showCompleted ? "grid-cols-4" : "grid-cols-[1fr_1fr_1fr_36px]")}>
            {[3, 2, 2, ...(showCompleted ? [2] : [])].map((cardCount, colIdx) => (
              <div key={colIdx} className="flex min-h-0 flex-col rounded-lg border border-border/60 bg-card/60">
                <div className="border-b border-border/60 bg-muted/30 px-3 py-2">
                  <Skeleton className="h-3 w-16" />
                </div>
                <div className="min-h-0 flex-1 space-y-2 p-2">
                  {Array.from({ length: cardCount }).map((_, i) => (
                    <div key={i} className="rounded-lg border bg-background/75 p-3">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="mt-1 h-3 w-1/2" />
                      <Skeleton className="mt-2 h-3 w-1/3" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!showCompleted && (
              <div className="h-full rounded-lg border border-dashed border-border/60 bg-muted/20" />
            )}
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
            <CircleDot className="size-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No issues</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Create one to get started.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className={cn("grid h-full gap-4 animate-[fade-up_200ms_ease-out_both]", showCompleted ? "grid-cols-4" : "grid-cols-[1fr_1fr_1fr_36px]")}>
              {COLUMNS.filter(col => col.id !== "completed" || showCompleted).map((col) => {
                const columnIssues = issues.filter((issue) => (col.statuses as readonly string[]).includes(issue.status));
                return (
                  <DroppableColumn key={col.id} id={col.id}>
                    <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                      <span>{col.label}</span>
                      <div className="flex items-center gap-1.5">
                        <span>{columnIssues.length}</span>
                        {col.id === "completed" && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  aria-label="Hide completed column"
                                  disabled={!!activeDragId}
                                  onClick={() => setShowCompleted(false)}
                                  className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground disabled:opacity-40"
                                />
                              }
                            >
                              <EyeOff className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipContent>Hide completed</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                    <div className={cn("min-h-0 flex-1 space-y-2 overflow-y-auto thin-scrollbar p-2", col.id === "completed" && "animate-[fade-up_300ms_ease-out_both]")}>
                      {columnIssues.length === 0 ? (
                        <div className="flex h-full min-h-20 items-center justify-center rounded-lg border border-dashed border-border/45 text-xs text-muted-foreground/70">
                          Empty
                        </div>
                      ) : (
                        columnIssues.map((issue) => (
                          <DraggableIssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} agent={agentsById.get(issue.agent_id ?? "") ?? null} agentsById={agentsById} />
                        ))
                      )}
                    </div>
                  </DroppableColumn>
                );
              })}
              {!showCompleted && (
                <CollapsedCompletedStrip
                  activeDragId={activeDragId}
                  completedCount={issues.filter(i => (COLUMNS[3].statuses as readonly string[]).includes(i.status)).length}
                  onExpand={() => setShowCompleted(true)}
                />
              )}
            </div>
            <DragOverlay style={{ zIndex: 9999 }}>
              {activeDragId ? (() => {
                const dragIssue = issues.find((i) => i.id === activeDragId);
                if (!dragIssue) return null;
                return <IssueCard issue={dragIssue} selected={false} onClick={() => {}} agent={agentsById.get(dragIssue.agent_id ?? "") ?? null} agentsById={agentsById} />;
              })() : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar p-3 lg:hidden">
        {boardLoading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-border/60 bg-card/60">
                <div className="border-b border-border/50 px-3 py-2">
                  <Skeleton className="h-4 w-20" />
                </div>
                <div className="space-y-2 p-3">
                  {Array.from({ length: 2 }).map((_, j) => (
                    <div key={j} className="rounded-lg border bg-background/75 p-3">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="mt-1 h-3 w-1/2" />
                      <Skeleton className="mt-2 h-3 w-1/3" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-2.5">
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
            <CircleDot className="size-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No issues yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Create one to get started.</p>
          </div>
        ) : (
          <div className="space-y-4 animate-[fade-up_200ms_ease-out_both]">
            {COLUMNS.map((col) => {
              if (col.id === "completed" && !showCompleted) return null;
              const columnIssues = issues.filter((issue) => (col.statuses as readonly string[]).includes(issue.status));
              if (columnIssues.length === 0) return null;
              return (
                <section key={col.id} className="rounded-lg border border-border/60 bg-card/60">
                  <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 text-sm font-medium">
                    <span>{col.label}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{columnIssues.length}</Badge>
                      {col.id === "completed" && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Hide completed column"
                                onClick={() => setShowCompleted(false)}
                                className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground"
                              />
                            }
                          >
                            <EyeOff className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>Hide completed</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 p-3">
                    {columnIssues.map((issue) => (
                      <IssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} agent={agentsById.get(issue.agent_id ?? "") ?? null} agentsById={agentsById} compact />
                    ))}
                  </div>
                </section>
              );
            })}
            {!showCompleted && (
              <div
                role="button"
                tabIndex={0}
                aria-label="Show completed issues"
                onClick={() => setShowCompleted(true)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowCompleted(true); } }}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/30"
              >
                <Eye className="size-3.5" />
                <span>Show Completed ({issues.filter(i => (COLUMNS[3].statuses as readonly string[]).includes(i.status)).length})</span>
              </div>
            )}
          </div>
        )}
      </div>

      <IssueSheet
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        agents={agents}
        issue={selectedIssue}
        detail={detail ? { messages: detail.messages, comments: detail.comments, artifacts: detail.artifacts, traceId: detail.issue.trace_id } : null}
        detailLoading={detailLoading}
        activeTask={activeTask}
        traceTasks={traceTasks}
        submitting={creating}
        defaultAgentId={recentAgentId}
        slug={slug}
        workspaceId={workspaceId}
        draft={draft}
        onDraftChange={setDraft}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onStatusChange={handleStatusChange}
        onCommented={() => selectedId && openIssue(selectedId)}
        onDispatched={(id) => { silentReload(); openIssue(id); }}
        onArtifactClick={handleArtifactClick}
      />

      <ArtifactSheet
        open={artifactSheetOpen}
        onOpenChange={(v) => {
          setArtifactSheetOpen(v);
          if (!v) setTimeout(() => setSelectedArtifact(null), 300);
        }}
        artifacts={issueArtifacts}
        workspaceId={workspaceId}
        initialArtifact={selectedArtifact}
        versionMap={artifactVersionMap}
        duplicateFilenames={artifactDuplicateFilenames}
      />
    </div>
  );
}
