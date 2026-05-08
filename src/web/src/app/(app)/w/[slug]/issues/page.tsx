"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { Check, CircleDot, Eye, EyeOff, File as FileIcon, GitBranch, Loader2, MessageSquare, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import type { Agent, Artifact, Issue, IssueComment, Message, WsMessage } from "@alook/shared";
import { isTerminalIssueStatus } from "@alook/shared";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { createIssue, deleteIssue, getIssue, getTask, getTaskMessages, listIssues, updateIssue } from "@/lib/api";
import type { TaskApi, TaskMessage } from "@alook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "@/components/ui/select";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, useDraggable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";

// TODO: re-enable when Codex CLI fixes image_url serialization bug
// const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
// const MAX_ATTACHMENTS = 10;

const SIDECAR_MIN_WIDTH = 320;
const SIDECAR_MAX_WIDTH_RATIO = 0.8;
const SIDECAR_DEFAULT_WIDTH = 448;

const COLUMNS = [
  { id: "todo", label: "Todo", statuses: ["todo"] },
  { id: "in_progress", label: "In Progress", statuses: ["in_progress"] },
  { id: "review", label: "Review", statuses: ["review"] },
  { id: "completed", label: "Completed", statuses: ["done", "closed", "canceled", "failed"] },
] as const;
const SELECTOR_STATUSES = ["todo", "in_progress", "review", "done"] as const;

function statusLabel(status: string) {
  if (status === "done") return "Complete";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function AgentIdentity({ agent, muted = false, size = 24 }: { agent: Agent; muted?: boolean; size?: number }) {
  const email = agent.email_handle ? `${agent.email_handle}@alook.ai` : "";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AgentAvatar agent={agent} size={size} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className={cn("truncate text-sm font-medium", muted && "text-muted-foreground")}>{agent.name}</div>
        {email ? (
          <div className="truncate text-xs text-muted-foreground">{email}</div>
        ) : null}
      </div>
    </div>
  );
}

function IssueCard({
  issue,
  selected,
  onClick,
  onDelete,
  agent,
  compact = false,
}: {
  issue: Issue;
  selected: boolean;
  onClick: () => void;
  onDelete?: () => void;
  agent?: Agent | null;
  compact?: boolean;
}) {
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
            {agent ? (
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

function DraggableIssueCard({
  issue,
  selected,
  onClick,
  onDelete,
  agent,
  compact = false,
}: {
  issue: Issue;
  selected: boolean;
  onClick: () => void;
  onDelete?: () => void;
  agent?: Agent | null;
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
      <IssueCard issue={issue} selected={selected} onClick={onClick} onDelete={onDelete} agent={agent} compact={compact} />
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  if (message.role === "event") {
    return (
      <div className="rounded-md border bg-muted/50 text-muted-foreground text-xs px-3 py-2">
        {message.content}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border/60 bg-background/55 p-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="capitalize">{message.role}</span>
        <span>{new Date(message.created_at).toLocaleString()}</span>
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm break-words">
        <Streamdown>{message.content}</Streamdown>
      </div>
    </div>
  );
}

function CommentRow({ comment, agents }: { comment: IssueComment; agents: Agent[] }) {
  const authorLabel = comment.author_type === "agent"
    ? agents.find((a) => a.id === comment.author_id)?.name ?? "Agent"
    : "You";

  return (
    <div className="rounded-lg border border-border/60 bg-background p-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium">{authorLabel}</span>
        <span>{new Date(comment.created_at).toLocaleString()}</span>
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm break-words">
        <Streamdown>{comment.content}</Streamdown>
      </div>
    </div>
  );
}

function CommentInput({ issueId, workspaceId, onCommented }: { issueId: string; workspaceId: string; onCommented: () => void }) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    try {
      await fetch(`/api/issues/${issueId}/comments?workspace_id=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.trim() }),
      });
      setContent("");
      onCommented();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pt-3 space-y-2">
      <Textarea
        placeholder="Leave a comment..."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="min-h-[60px] text-sm"
        onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) submit(); }}
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={!content.trim() || submitting}>
          {submitting ? "Sending..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function AttachmentList({ artifacts, workspaceId }: { artifacts: Artifact[]; workspaceId: string }) {
  if (artifacts.length === 0) return null;

  return (
    <div className="space-y-1">
      {artifacts.map((artifact) => (
        <a
          key={artifact.id}
          href={`/api/artifacts/${artifact.id}/content?workspace_id=${workspaceId}&download=1`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
        >
          <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{artifact.filename}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(artifact.size)}</span>
        </a>
      ))}
    </div>
  );
}

export default function IssuesPage() {
  const { workspaceId, slug } = useWorkspace();
  const { agents, loading: agentsLoading, subscribeWs } = useAgentContext();
  const [recentAgentId, setRecentAgentId] = useLocalStorage<string>(`issue-recent-agent-id-${workspaceId}`, "");
  const [draft, setDraft] = useLocalStorage<{ title: string; description: string; agentId?: string }>(`issue-draft-${workspaceId}`, { title: "", description: "" });
  const [showCompleted, setShowCompleted] = useLocalStorage<boolean>("issues-show-completed", true);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ issue: Issue & { trace_id?: string | null }; messages: Message[]; comments: IssueComment[]; artifacts: Artifact[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTask, setActiveTask] = useState<TaskApi | null>(null);
  const [taskLatestText, setTaskLatestText] = useState<string>("");
  const [form, setForm] = useState({ title: "", description: "", agentId: "" });
  const [sidecarWidth, setSidecarWidth] = useState(SIDECAR_DEFAULT_WIDTH);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const sidecarDragging = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingStatusUpdate = useRef<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const selectedFormAgent = agentsById.get(form.agentId) ?? null;

  function agentName(agentId: string | null) {
    if (!agentId) return "Unassigned";
    return agentsById.get(agentId)?.name ?? agentId;
  }

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

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const formHydrated = useRef(false);

  useEffect(() => {
    if (formHydrated.current) return;
    if (draft.agentId !== undefined) {
      formHydrated.current = true;
      setForm({ title: draft.title, description: draft.description, agentId: draft.agentId });
    } else if (agents.length > 0) {
      formHydrated.current = true;
      const preferredValid = recentAgentId && agents.some((a) => a.id === recentAgentId);
      const preferred = preferredValid ? recentAgentId : agents[0].id;
      setForm((prev) => ({ ...prev, agentId: preferred }));
    }
  }, [draft, agents, recentAgentId]);

  useEffect(() => {
    if (!dialogOpen) return;
    setDraft({ title: form.title, description: form.description, agentId: form.agentId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.title, form.description, form.agentId, dialogOpen]);

  async function openIssue(issueId: string) {
    setSelectedId(issueId);
    setDetailLoading(true);
    try {
      const res = await getIssue(workspaceId, issueId);
      setDetail(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load issue");
    } finally {
      setDetailLoading(false);
    }
  }

  const detailConvId = detail?.issue.conversation_id ?? null;
  const detailTaskId = detail?.issue.latest_task_id ?? null;
  const isTaskActive = activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);

  useEffect(() => {
    if (!detailTaskId) { setActiveTask(null); setTaskLatestText(""); return; }
    let cancelled = false;
    getTask(detailTaskId, workspaceId).then((task) => {
      if (!cancelled) setActiveTask(task);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [detailTaskId, workspaceId]);

  useEffect(() => {
    if (!isTaskActive || !detailTaskId) return;
    let cancelled = false;
    const poll = () => {
      getTaskMessages(detailTaskId, workspaceId).then((msgs) => {
        if (cancelled) return;
        const texts = msgs.filter((m: TaskMessage) => m.type === "text");
        if (texts.length > 0) setTaskLatestText(texts[texts.length - 1].content);
      }).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isTaskActive, detailTaskId, workspaceId]);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "conversation.message" && detailConvId && msg.conversationId === detailConvId) {
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
            setIssues((prev) => prev.map((i) => i.conversation_id === detailConvId ? { ...i, status: newStatus, updated_at: msg.message.created_at } : i));
          }
        }
      }
      if (msg.type === "issue.comment" && selectedId === msg.issueId) {
        setDetail((prev) => {
          if (!prev) return prev;
          if (prev.comments.some((c) => c.id === msg.comment.id)) return prev;
          return { ...prev, comments: [...prev.comments, msg.comment] };
        });
      }
      if (msg.type === "task.updated" && (msg.status === "running" || msg.status === "completed" || msg.status === "failed")) {
        if (!pendingStatusUpdate.current) {
          reload();
          if (selectedId) openIssue(selectedId);
        }
        if (detailTaskId) {
          getTask(detailTaskId, workspaceId).then(setActiveTask).catch(() => {});
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailConvId, selectedId, subscribeWs]);

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [detail]);

  async function handleCreate() {
    if (!form.title.trim()) return;
    setCreating(true);
    try {
      const res = await createIssue(workspaceId, {
        agent_id: form.agentId || undefined,
        title: form.title.trim(),
        description: form.description.trim(),
        // files: attachments, // TODO: disabled until Codex CLI fixes image_url serialization bug
      });
      setIssues((prev) => [res.issue, ...prev]);
      setDialogOpen(false);
      if (form.agentId) setRecentAgentId(form.agentId);
      resetDraft();
      await openIssue(res.issue.id);
      toast.success("Issue created");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setCreating(false);
    }
  }

  const handleDeleteIssue = useCallback(async (issueId: string) => {
    try {
      await deleteIssue(workspaceId, issueId);
      setIssues((prev) => prev.filter((i) => i.id !== issueId));
      if (selectedId === issueId) {
        setSelectedId(null);
        setDetail(null);
      }
      toast.success("Issue deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete issue");
    }
  }, [workspaceId, selectedId]);

  const onSidecarPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    sidecarDragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onSidecarPointerMove = useCallback((e: React.PointerEvent) => {
    if (!sidecarDragging.current) return;
    const maxW = window.innerWidth * SIDECAR_MAX_WIDTH_RATIO;
    setSidecarWidth(Math.min(maxW, Math.max(SIDECAR_MIN_WIDTH, window.innerWidth - e.clientX)));
  }, []);
  const onSidecarPointerUp = useCallback(() => { sidecarDragging.current = false; }, []);

  // TODO: attachment functions disabled until Codex CLI fixes image_url serialization bug
  // function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) { ... }
  // function removeAttachment(index: number) { ... }

  function resetDraft() {
    const preferredValid = recentAgentId && agents.some((a) => a.id === recentAgentId);
    const defaultAgent = preferredValid ? recentAgentId : agents[0]?.id || "";
    setForm({ title: "", description: "", agentId: defaultAgent });
    setDraft({ title: "", description: "" });
    formHydrated.current = true;
  }

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

    const newStatus = targetColId === "completed" ? "done" : targetColId;
    const oldStatus = issue.status;

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

  async function handleStatusChange(newStatus: string) {
    if (!detail) return;
    const issueId = detail.issue.id;
    const oldStatus = detail.issue.status;
    if (newStatus === oldStatus) return;

    const now = new Date().toISOString();
    setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: newStatus as Issue["status"], updated_at: now } } : prev);
    setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, status: newStatus as Issue["status"], updated_at: now } : i));

    pendingStatusUpdate.current = issueId;
    try {
      await updateIssue(workspaceId, issueId, { status: newStatus as Issue["status"] });
    } catch (err) {
      setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: oldStatus } } : prev);
      setIssues((prev) => prev.map((i) => i.id === issueId ? { ...i, status: oldStatus } : i));
      toast.error(err instanceof Error ? err.message : "Failed to update issue status");
    } finally {
      pendingStatusUpdate.current = null;
    }
  }

  const boardLoading = loading || agentsLoading;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background/30">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-normal">Issues</h1>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
          }}
        >
          {!showCompleted && (
            <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => setShowCompleted(true)}>
              <Eye className="size-3" />
              Show completed
            </Button>
          )}
          <DialogTrigger render={<Button size="sm" className="w-full sm:w-auto" />}>
            <Plus className="size-4" />
            New issue
          </DialogTrigger>
          <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] grid-rows-none flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
            <div className="flex shrink-0 items-center border-b border-border/40 px-4 py-2">
              <DialogTitle className="text-sm tracking-tight">New Issue</DialogTitle>
            </div>

            <div className="shrink-0 space-y-1 border-b border-border/30 px-4 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="w-18 shrink-0 text-muted-foreground">Title</span>
                <div className="-ml-1.5 min-w-0 flex-1 rounded-md bg-muted/40">
                  <Input
                    id="issue-title"
                    value={form.title}
                    onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="Short, actionable summary"
                    className="h-7 border-0 bg-transparent px-1.5 text-sm shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/50"
                    disabled={creating}
                  />
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="w-18 shrink-0 text-muted-foreground">Assign</span>
                <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        disabled={creating}
                        className="-ml-1.5 flex h-7 min-w-0 flex-1 items-center rounded-md bg-muted/40 px-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                      />
                    }
                  >
                    {selectedFormAgent ? (
                      <AgentIdentity agent={selectedFormAgent} size={18} />
                    ) : (
                      <span className="text-sm text-muted-foreground/70">Unassigned</span>
                    )}
                  </PopoverTrigger>
                  <PopoverContent align="start" className="max-h-64 w-72 overflow-y-auto p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setForm((prev) => ({ ...prev, agentId: "" }));
                        setDraft((prev) => ({ ...prev, agentId: "" }));
                        setAssigneeOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <span className="text-muted-foreground">None (unassigned)</span>
                      {!form.agentId ? <Check className="size-3.5 shrink-0" /> : null}
                    </button>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => {
                          setForm((prev) => ({ ...prev, agentId: agent.id }));
                          setDraft((prev) => ({ ...prev, agentId: agent.id }));
                          setAssigneeOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <AgentIdentity agent={agent} size={18} />
                        {form.agentId === agent.id ? <Check className="size-3.5 shrink-0" /> : null}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-4 py-3">
              <MarkdownEditor
                value={form.description}
                onChange={(description) => setForm((prev) => ({ ...prev, description }))}
                placeholder="Context, constraints, expected outcome"
                minHeight="14rem"
                variant="seamless"
                contentType="markdown"
                agents={agents}
                className="min-h-full"
              />
            </div>

            <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border/30 px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    setDialogOpen(false);
                    resetDraft();
                  }}
                  disabled={creating}
                >
                  <X className="mr-1 size-3" />
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={handleCreate}
                  disabled={creating || !form.title.trim()}
                >
                  {creating ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Plus className="mr-1 size-3" />}
                  Create
                </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="hidden min-h-0 flex-1 lg:block overflow-y-auto thin-scrollbar p-4">
        {boardLoading ? (
          <div className={cn("grid h-full gap-4", showCompleted ? "grid-cols-4" : "grid-cols-3")}>
            {Array.from({ length: showCompleted ? 12 : 9 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
            <CircleDot className="size-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No issues</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Create one to get started.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className={cn("grid h-full gap-4", showCompleted ? "grid-cols-4" : "grid-cols-3")}>
              {COLUMNS.filter(col => col.id !== "completed" || showCompleted).map((col) => {
                const columnIssues = issues.filter((issue) => (col.statuses as readonly string[]).includes(issue.status));
                return (
                  <DroppableColumn key={col.id} id={col.id}>
                    <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                      <span>{col.label}</span>
                      <div className="flex items-center gap-1.5">
                        <span>{columnIssues.length}</span>
                        {col.id === "completed" && (
                          <button
                            type="button"
                            disabled={!!activeDragId}
                            onClick={() => setShowCompleted(false)}
                            className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground disabled:opacity-40"
                          >
                            <EyeOff className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto thin-scrollbar p-2">
                      {columnIssues.length === 0 ? (
                        <div className="flex h-full min-h-20 items-center justify-center rounded-lg border border-dashed border-border/45 text-xs text-muted-foreground/70">
                          Empty
                        </div>
                      ) : (
                        columnIssues.map((issue) => (
                          <DraggableIssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} agent={agentsById.get(issue.agent_id ?? "") ?? null} />
                        ))
                      )}
                    </div>
                  </DroppableColumn>
                );
              })}
            </div>
            <DragOverlay style={{ zIndex: 9999 }}>
              {activeDragId ? (() => {
                const dragIssue = issues.find((i) => i.id === activeDragId);
                if (!dragIssue) return null;
                return <IssueCard issue={dragIssue} selected={false} onClick={() => {}} agent={agentsById.get(dragIssue.agent_id ?? "") ?? null} />;
              })() : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar p-3 lg:hidden">
        {boardLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : issues.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full animate-[fade-up_400ms_ease-out_both]">
            <CircleDot className="size-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No issues yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Create one to get started.</p>
          </div>
        ) : (
          <div className="space-y-4">
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
                        <button
                          type="button"
                          onClick={() => setShowCompleted(false)}
                          className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground"
                        >
                          <EyeOff className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 p-3">
                    {columnIssues.map((issue) => (
                      <IssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} agent={agentsById.get(issue.agent_id ?? "") ?? null} compact />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      <Sheet open={!!selectedId} onOpenChange={(open) => { if (!open) { setSelectedId(null); setDetail(null); setActiveTask(null); setTaskLatestText(""); } }}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
          style={{ width: `min(${sidecarWidth}px, 100vw)`, maxWidth: "none" }}
        >
          <div
            onPointerDown={onSidecarPointerDown}
            onPointerMove={onSidecarPointerMove}
            onPointerUp={onSidecarPointerUp}
            onLostPointerCapture={onSidecarPointerUp}
            className="hidden sm:block absolute -left-px top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-primary/20 active:bg-primary/30 transition-colors rounded-l-xl"
          />
          <SheetHeader className="relative z-10 border-b-0 pb-2">
            <SheetTitle>
              {detailLoading || !detail ? (
                <div className="space-y-2">
                  <Skeleton className="h-5 w-56" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-base font-semibold">{detail.issue.title}</span>
                    <Button variant="ghost" size="icon-sm" className="ml-auto shrink-0" onClick={() => { setSelectedId(null); setDetail(null); setActiveTask(null); setTaskLatestText(""); }}>
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {detail.issue.agent_id && detail.issue.conversation_id && (
                      <div className="flex items-center gap-0.5">
                        <Link
                          href={`/w/${slug}/agents/${detail.issue.agent_id}?conv=${detail.issue.conversation_id}${detail.issue.latest_task_id ? `&task=${detail.issue.latest_task_id}` : ""}`}
                          className="group inline-flex items-center rounded-lg text-xs text-muted-foreground h-7 px-2 hover:bg-muted hover:text-foreground transition-all"
                        >
                          <MessageSquare className="size-3 shrink-0" />
                          <span className="max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300 overflow-hidden transition-all duration-500 ease-out">Chat</span>
                        </Link>
                        {detail.issue.trace_id && (
                          <Link
                            href={`/w/${slug}/threads/${detail.issue.trace_id}`}
                            className="group inline-flex items-center rounded-lg text-xs text-muted-foreground h-7 px-2 hover:bg-muted hover:text-foreground transition-all"
                          >
                            <GitBranch className="size-3 shrink-0" />
                            <span className="max-w-0 opacity-0 group-hover:max-w-20 group-hover:opacity-100 group-hover:ml-1 group-hover:delay-300 overflow-hidden transition-all duration-500 ease-out">Thread</span>
                          </Link>
                        )}
                      </div>
                    )}
                    <Select value={detail.issue.status} onValueChange={(val) => { if (val) handleStatusChange(val); }}>
                      <SelectTrigger className="w-fit h-5 shrink-0 gap-1 rounded-full border px-2 text-[10px] font-medium">
                        {detail.issue.status === "in_progress" && <Loader2 className="size-3 animate-spin" />}
                        <SelectValue placeholder={statusLabel(detail.issue.status)} />
                      </SelectTrigger>
                      <SelectPopup portal={false} alignItemWithTrigger={false} side="bottom" sideOffset={4} className="min-w-0 p-0.5">
                        {SELECTOR_STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="py-1 pl-1.5 pr-6 text-[11px]">{statusLabel(s)}</SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {detail.issue.agent_id && agentsById.get(detail.issue.agent_id) ? (
                      <span className="flex items-center gap-1">
                        <AgentAvatar agent={agentsById.get(detail.issue.agent_id)} size={14} />
                        <span className="truncate">{agentName(detail.issue.agent_id)}</span>
                      </span>
                    ) : !detail.issue.agent_id ? (
                      <span className="text-muted-foreground/60">Unassigned</span>
                    ) : null}
                    <span className="shrink-0">{formatDate(detail.issue.updated_at)}</span>
                  </div>
                </div>
              )}
            </SheetTitle>
          </SheetHeader>
          {detailLoading || !detail ? (
            <div className="flex-1 px-6 py-5 space-y-3">
              <Skeleton className="h-24" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <>
              <div className="shrink-0 space-y-6 px-6 pt-2 pb-3">
                {detail.issue.description && (
                  <div className="prose prose-sm dark:prose-invert max-w-none text-sm break-words">
                    <Streamdown>{detail.issue.description}</Streamdown>
                  </div>
                )}
                <AttachmentList artifacts={detail.artifacts ?? []} workspaceId={workspaceId} />
              </div>

              <div ref={timelineRef} className="flex-1 min-h-0 overflow-y-auto thin-scrollbar mx-6 mt-2 mb-4 px-4 py-4 space-y-3 border rounded-lg">
                {(() => {
                  const events = detail.messages
                    .filter((m) => m.role === "event")
                    .map((m) => ({ kind: "event" as const, id: m.id, created_at: m.created_at, data: m }));
                  const comments = (detail.comments ?? [])
                    .map((c) => ({ kind: "comment" as const, id: c.id, created_at: c.created_at, data: c }));
                  const timeline = [...events, ...comments].sort(
                    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                  );

                  if (timeline.length === 0 && !isTaskActive) {
                    return <div className="text-xs text-muted-foreground">No activity yet.</div>;
                  }

                  return (
                    <div className="relative pl-4">
                      <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
                      <div className="space-y-3">
                        {timeline.map((item) => (
                          <div key={item.id} className="relative">
                            <div className="absolute -left-4 top-2.5 size-2.5 rounded-full border-2 border-background bg-muted-foreground/40" />
                            {item.kind === "event"
                              ? <MessageRow message={item.data} />
                              : <CommentRow comment={item.data} agents={agents} />
                            }
                          </div>
                        ))}
                        {isTaskActive && (
                          <div className="relative">
                            <div className="absolute -left-4 top-2.5 size-2.5 rounded-full border-2 border-background bg-emerald-500 animate-pulse" />
                            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">Working</div>
                              {taskLatestText && <p className="mt-1 text-[11px] text-muted-foreground line-clamp-2">{taskLatestText}</p>}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {!isTaskActive && !isTerminalIssueStatus(detail.issue.status) && (
                <div className="shrink-0 px-6 pb-4">
                  <CommentInput issueId={detail.issue.id} workspaceId={workspaceId} onCommented={() => openIssue(detail.issue.id)} />
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
