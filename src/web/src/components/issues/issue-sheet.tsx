"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { useSheetResize, SheetResizeHandle } from "@/components/ui/sheet-resize-handle";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  ArrowUp,
  Check,
  CircleDot,
  File as FileIcon,
  GitBranch,
  Loader2,
  MessageSquare,
  User,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import { mermaid, cjk } from "@/lib/streamdown-plugins";
import type { Agent, Artifact, Issue, IssueComment, Message, TaskApi } from "@alook/shared";
import { isPreviewable, getArtifactUrl } from "@/components/artifact-content-renderer";
import { formatSize } from "@/components/agent-chat/artifact-sheet";
import { isTerminalIssueStatus, toAlookAddress } from "@alook/shared";
import type { TraceTask } from "@/lib/api";
import { updateIssue } from "@/lib/api";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Kbd } from "@/components/ui/kbd";
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea";

// --- Constants ---

const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8;

const GHOST_CONTROL =
  "h-7 border-0 bg-transparent px-2 text-xs text-foreground hover:bg-accent transition-colors -ml-2";


const SELECTOR_STATUSES = ["todo", "in_progress", "review", "done"] as const;

function statusLabel(status: string) {
  if (status === "done") return "Complete";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Sub-components ---

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

function AgentIdentity({ agent, size = 24 }: { agent: Agent; size?: number }) {
  const email = agent.email_handle ? toAlookAddress(agent.email_handle) : "";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AgentAvatar agent={agent} size={size} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="truncate text-xs font-medium">{agent.name}</div>
        {email ? <div className="truncate text-[11px] text-muted-foreground">{email}</div> : null}
      </div>
    </div>
  );
}

interface PropertyRowProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
}

function PropertyRow({ icon, children }: PropertyRowProps) {
  return (
    <div className="group flex items-center gap-2">
      <span className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">{children}</div>
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
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm wrap-break-word">
        <Streamdown plugins={{ mermaid, cjk }}>{message.content}</Streamdown>
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
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm wrap-break-word">
        <Streamdown plugins={{ mermaid, cjk }}>{comment.content}</Streamdown>
      </div>
    </div>
  );
}

function AttachmentList({ artifacts, workspaceId, onArtifactClick }: { artifacts: Artifact[]; workspaceId: string; onArtifactClick?: (artifact: Artifact) => void }) {
  if (artifacts.length === 0) return null;
  const baseCls = "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent";
  return (
    <div className="space-y-1">
      {artifacts.map((artifact) => {
        const canPreview = onArtifactClick && isPreviewable(artifact);
        const inner = (
          <>
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{artifact.filename}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatSize(artifact.size)}</span>
          </>
        );
        return canPreview ? (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onArtifactClick(artifact)}
            className={cn(baseCls, "w-full text-left")}
          >
            {inner}
          </button>
        ) : (
          <a
            key={artifact.id}
            href={getArtifactUrl(artifact.id, workspaceId, true)}
            target="_blank"
            rel="noopener noreferrer"
            className={baseCls}
          >
            {inner}
          </a>
        );
      })}
    </div>
  );
}

// --- Main component ---

export interface IssueSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  issue?: Issue | null;
  detail?: { messages: Message[]; comments: IssueComment[]; artifacts: Artifact[]; traceId?: string | null } | null;
  detailLoading?: boolean;
  activeTask?: TaskApi | null;
  traceTasks?: TraceTask[] | null;
  submitting?: boolean;
  defaultAgentId?: string;
  slug: string;
  workspaceId: string;
  draft?: { title: string; description: string; agentId: string };
  onDraftChange?: (draft: { title: string; description: string; agentId: string }) => void;
  onCreate?: (values: { agent_id?: string; title: string; description: string }) => Promise<void>;
  onUpdate?: (issueId: string, patch: { title?: string; description?: string }) => void;
  onStatusChange?: (issueId: string, status: string) => Promise<void>;
  onCommented?: () => void;
  onDispatched?: (issueId: string) => void;
  onArtifactClick?: (artifact: Artifact) => void;
}

export function IssueSheet({
  open,
  onOpenChange,
  agents,
  issue,
  detail,
  detailLoading,
  activeTask,
  traceTasks,
  submitting,
  defaultAgentId,
  slug,
  workspaceId,
  draft,
  onDraftChange,
  onCreate,
  onUpdate,
  onStatusChange,
  onCommented,
  onDispatched,
  onArtifactClick,
}: IssueSheetProps) {
  const mode = issue ? "detail" : "create";

  // Local editing state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [commentContent, setCommentContent] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [confirmAgent, setConfirmAgent] = useState<Agent | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const descriptionRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const isTaskActive = activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);
  const hasActiveTraceTasks = traceTasks?.some(t => ["queued", "dispatched", "running"].includes(t.status)) ?? false;

  // Seed state on open/issue change
  useEffect(() => {
    if (!open) return;
    if (issue) {
      setTitle(issue.title);
      setDescription(issue.description ?? "");
    } else {
      setTitle(draft?.title ?? "");
      setDescription(draft?.description ?? "");
      setAgentId(draft?.agentId || defaultAgentId || "");
    }
  }, [open, issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync draft to parent (create mode only)
  useEffect(() => {
    if (mode !== "create" || !open) return;
    onDraftChange?.({ title, description, agentId });
  }, [title, description, agentId, mode, open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll timeline
  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [detail?.messages?.length, detail?.comments?.length, traceTasks?.length]);

  // Auto-save (detail mode): debounce title/description changes
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);
  const titleRef2 = useRef(title);
  useEffect(() => { titleRef2.current = title; }, [title]);
  const descriptionRef2 = useRef(description);
  useEffect(() => { descriptionRef2.current = description; }, [description]);
  const issueRef = useRef(issue);
  useEffect(() => { issueRef.current = issue; }, [issue]);

  const flushAutoSave = useCallback(() => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    const iss = issueRef.current;
    if (!iss) return;
    const titleChanged = titleRef2.current !== iss.title;
    const descChanged = descriptionRef2.current !== (iss.description ?? "");
    if (!titleChanged && !descChanged) return;
    if (!titleRef2.current.trim()) return;
    const patch: { title?: string; description?: string } = {};
    if (titleChanged) patch.title = titleRef2.current.trim();
    if (descChanged) patch.description = descriptionRef2.current.trim();
    onUpdateRef.current?.(iss.id, patch);
  }, []);

  useEffect(() => {
    if (mode !== "detail" || !issue || !open) return;
    const titleChanged = title !== issue.title;
    const descChanged = description !== (issue.description ?? "");
    if (!titleChanged && !descChanged) return;
    if (!title.trim()) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(flushAutoSave, 500);

    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [title, description, mode, issue, open, flushAutoSave]);

  // Flush pending auto-save when sheet closes
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (prevOpenRef.current && !open && mode === "detail") {
      flushAutoSave();
    }
    prevOpenRef.current = open;
  }, [open, mode, flushAutoSave]);

  // --- Drag handle ---
  const { width, onPointerDown, onPointerMove, onPointerUp } = useSheetResize({
    defaultWidth: 448,
    minWidth: MIN_WIDTH,
    maxWidthRatio: MAX_WIDTH_RATIO,
  });

  // --- Handlers ---
  const handleCreate = async () => {
    if (!title.trim() || submitting) return;
    await onCreate?.({ agent_id: agentId || undefined, title: title.trim(), description: description.trim() });
  };


  const handleStatusChange = (newStatus: string) => {
    if (!issue || newStatus === issue.status) return;
    onStatusChange?.(issue.id, newStatus);
  };

  const handleCommentSubmit = async () => {
    if (!commentContent.trim() || commentSubmitting || !issue) return;
    setCommentSubmitting(true);
    try {
      const res = await fetch(`/api/issues/${issue.id}/comments?workspace_id=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: commentContent.trim() }),
      });
      if (!res.ok) throw new Error("Failed to send comment");
      setCommentContent("");
      onCommented?.();
    } catch {
      toast.error("Failed to send comment");
    } finally {
      setCommentSubmitting(false);
    }
  };

  // Shift+Enter capture handler (create mode only — detail auto-saves)
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const onKeyDownCapture = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey && mode === "create") {
      if (commentRef.current && commentRef.current.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      handleCreate();
    }
  }, [mode, title, description, agentId, submitting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter on title → focus description
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const editor = descriptionRef.current?.querySelector('[contenteditable="true"]') as HTMLElement | null;
      editor?.focus();
    }
  };

  const isTodoDraft = mode === "detail" && issue?.status === "todo";

  const selectedAgent = agents.find((a) => a.id === agentId) ?? null;
  const detailAgent = issue?.agent_id ? agents.find((a) => a.id === issue.agent_id) ?? null : null;

  // Mobile tab state (only used below lg breakpoint)
  const [mobileTab, setMobileTab] = useState<"issue" | "activity">("issue");

  // Reset tab when switching issues or modes
  useEffect(() => {
    setMobileTab("issue");
  }, [issue?.id, mode]);

  const timelineContent = (
    <>
      {detailLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-8" />
          <Skeleton className="h-12" />
        </div>
      ) : (() => {
        const events = (detail?.messages ?? [])
          .filter((m) => m.role === "event")
          .map((m) => ({ kind: "event" as const, id: m.id, created_at: m.created_at, data: m }));
        const comments = (detail?.comments ?? [])
          .map((c) => ({ kind: "comment" as const, id: c.id, created_at: c.created_at, data: c }));
        const timeline = [...events, ...comments].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );

        if (timeline.length === 0 && !isTaskActive) {
          return <div className="text-xs text-muted-foreground">No activity yet.</div>;
        }

        return (
          <div className="relative pl-4">
            <div className="absolute left-[4.5px] top-2 bottom-2 w-px bg-border" />
            <div className="space-y-3">
              {timeline.map((item) => (
                <div key={item.id} className="relative">
                  <div className="absolute -left-4 top-2 size-2.5 rounded-full border-2 border-background bg-muted-foreground/40" />
                  {item.kind === "event"
                    ? <MessageRow message={item.data} />
                    : <CommentRow comment={item.data} agents={agents} />}
                </div>
              ))}
              {(isTaskActive || hasActiveTraceTasks) && (() => {
                const activeTraceTasks = traceTasks?.filter(t => ["queued", "dispatched", "running"].includes(t.status));
                if (activeTraceTasks && activeTraceTasks.length > 0) {
                  return activeTraceTasks.map(t => {
                    const isRunning = t.status === "running";
                    return (
                      <div key={t.id} className="relative">
                        <div className={cn(
                          "absolute -left-4 top-2 size-2.5 rounded-full border-2 border-background",
                          isRunning ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"
                        )} />
                        <div className={cn(
                          "rounded-md border px-3 py-2",
                          isRunning ? "border-emerald-500/30 bg-emerald-500/10" : "border-border/60 bg-muted/30"
                        )}>
                          <div className="flex items-center gap-2 text-xs">
                            {t.agent && <AgentAvatar agent={{ avatar_url: t.agent.avatarUrl, name: t.agent.name } as Agent} size={16} />}
                            <span className={isRunning ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                              {t.agent?.name ?? "Agent"} {isRunning ? "is working" : "— queued"}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  });
                }
                return (
                  <div className="relative">
                    <div className="absolute -left-4 top-2 size-2.5 rounded-full border-2 border-background bg-emerald-500 animate-pulse" />
                    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">Working</div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })()}
    </>
  );

  const commentInput = mode === "detail" && issue && !isTodoDraft && !isTaskActive && !isTerminalIssueStatus(issue.status) ? (
    <div className="flex flex-col rounded-xl border bg-background/60 transition-colors duration-200 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      <textarea
        ref={commentRef}
        placeholder="Leave a comment..."
        value={commentContent}
        onChange={(e) => setCommentContent(e.target.value)}
        className="w-full resize-none bg-transparent px-4 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground field-sizing-content min-h-15 max-h-32 thin-scrollbar overflow-y-auto"
        onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); handleCommentSubmit(); } }}
      />
      <div className="flex items-center justify-between px-2 pb-2 pt-0.5">
        <Kbd className="text-[11px] text-muted-foreground/50">⇧↵</Kbd>
        <Button
          size="icon-sm"
          onClick={handleCommentSubmit}
          disabled={!commentContent.trim() || commentSubmitting}
          className={cn("rounded-lg transition-opacity duration-200", !commentContent.trim() && !commentSubmitting && "opacity-40")}
        >
          {commentSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
        </Button>
      </div>
    </div>
  ) : null;

  const issueFormContent = (
    <>
      {/* Title */}
      <div className="shrink-0 px-2 sm:px-3 pt-5 pb-1">
        <AutoResizeTextarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onTitleKeyDown}
          placeholder={mode === "create" ? "New issue" : "Untitled"}
          autoFocus={mode === "create"}
          rows={1}
          className="w-full rounded-none border-0 bg-transparent px-0 py-1 font-news text-2xl sm:text-3xl font-medium leading-[1.2] tracking-tight shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/40 placeholder:font-normal"
        />
      </div>

      {/* Properties */}
      <div className="shrink-0 space-y-2 px-2 sm:px-3 py-2">
        {/* Agent row */}
        <PropertyRow icon={<User className="size-3.5" />}>
          {mode === "create" || isTodoDraft ? (
            <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    disabled={submitting || dispatching}
                    className={cn(GHOST_CONTROL, "flex items-center gap-2 rounded-md")}
                  />
                }
              >
                {selectedAgent ? (
                  <span className="truncate">{selectedAgent.name}</span>
                ) : (
                  <span className="text-muted-foreground/70">Unassigned</span>
                )}
              </PopoverTrigger>
              <PopoverContent align="start" className="max-h-64 w-72 overflow-y-auto thin-scrollbar p-1">
                {!isTodoDraft && (
                  <button
                    type="button"
                    onClick={() => { setAgentId(""); setAssigneeOpen(false); }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="text-muted-foreground">None (unassigned)</span>
                    {!agentId ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                )}
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => {
                      if (isTodoDraft) {
                        setConfirmAgent(agent);
                      } else {
                        setAgentId(agent.id);
                      }
                      setAssigneeOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <AgentIdentity agent={agent} size={18} />
                    {agentId === agent.id ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          ) : (
            <span className="text-xs truncate">
              {detailAgent ? detailAgent.name : <span className="text-muted-foreground/70">Unassigned</span>}
            </span>
          )}
        </PropertyRow>

        {/* Status row (detail mode only) */}
        {mode === "detail" && issue && (
          <PropertyRow icon={<CircleDot className="size-3.5" />}>
            <Select
              value={issue.status}
              onValueChange={(val) => { if (val) handleStatusChange(val); }}
              items={(isTodoDraft ? (["todo", "done"] as const) : SELECTOR_STATUSES).map((s) => ({ value: s, label: statusLabel(s) }))}
            >
              <SelectTrigger className="h-7 w-auto border-none bg-transparent px-2 shadow-none text-xs text-foreground hover:bg-accent transition-colors rounded-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(isTodoDraft
                  ? (["todo", "done"] as const)
                  : SELECTOR_STATUSES
                ).map((s) => (
                  <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropertyRow>
        )}

        {/* Chat link row */}
        {mode === "detail" && issue?.agent_id && issue?.conversation_id && (
          <PropertyRow icon={<MessageSquare className="size-3.5" />}>
            <Link
              href={`/w/${slug}/agents/${issue.agent_id}?conv=${issue.conversation_id}${issue.latest_task_id ? `&task=${issue.latest_task_id}` : ""}`}
              className={cn(GHOST_CONTROL, "inline-flex items-center rounded-md")}
            >
              Chat
            </Link>
          </PropertyRow>
        )}

        {/* Thread link row */}
        {mode === "detail" && detail?.traceId && (
          <PropertyRow icon={<GitBranch className="size-3.5" />}>
            <Link
              href={`/w/${slug}/traces/${detail.traceId}`}
              className={cn(GHOST_CONTROL, "inline-flex items-center rounded-md")}
            >
              Thread
            </Link>
          </PropertyRow>
        )}
      </div>

      {/* Description */}
      <div
        className={cn(
          "px-2 sm:px-3 py-2 flex-1 min-h-0 overflow-y-auto thin-scrollbar"
        )}
        ref={descriptionRef}
      >
        <MarkdownEditor
          key={issue?.id ?? "new"}
          value={description}
          onChange={setDescription}
          placeholder="Describe the issue..."
          minHeight={mode === "create" ? "10rem" : "4rem"}
          variant="seamless"
          contentType="markdown"
          agents={agents}
        />
      </div>

      {/* Attachments (detail mode) */}
      {mode === "detail" && detail?.artifacts && detail.artifacts.length > 0 && (
        <div className="shrink-0 px-2 sm:px-3 py-2">
          <AttachmentList artifacts={detail.artifacts} workspaceId={workspaceId} onArtifactClick={onArtifactClick} />
        </div>
      )}
    </>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border overflow-visible"
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
      >
        {/* Resize drag handle */}
        <SheetResizeHandle onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />

        {/* Mobile close button */}
        <SheetClose
          render={<Button variant="ghost" size="icon-sm" />}
          className="absolute top-3 right-3 z-10 sm:hidden"
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </SheetClose>

        {/* Timeline floating panel — desktop only, detail mode only, not for todo drafts */}
        {mode === "detail" && !isTodoDraft && (
          <div className="hidden lg:flex absolute right-full top-0 bottom-0 mr-2 w-90 flex-col rounded-xl border bg-background shadow-lg overflow-hidden">
            <div className="shrink-0 flex items-center border-b px-4 py-2">
              <span className="text-xs font-medium text-muted-foreground">Activity</span>
            </div>
            <div ref={timelineRef} className="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-4 py-4 space-y-3">
              {timelineContent}
            </div>
            {commentInput && (
              <div className="shrink-0 border-t px-4 py-3">
                {commentInput}
              </div>
            )}
          </div>
        )}

        {/* Hidden accessible title */}
        <SheetTitle className="sr-only">
          {mode === "create" ? "New Issue" : (issue?.title ?? "Issue")}
        </SheetTitle>

        <div className="flex flex-1 min-h-0 flex-col" onKeyDownCapture={onKeyDownCapture}>
          {/* Mobile tab switcher (detail mode only, below lg, not for todo drafts) */}
          {mode === "detail" && !isTodoDraft && (
            <div className="shrink-0 flex items-center gap-1 border-b px-2 py-2 lg:hidden">
              <button
                type="button"
                onClick={() => setMobileTab("issue")}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  mobileTab === "issue" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Issue
              </button>
              <button
                type="button"
                onClick={() => setMobileTab("activity")}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  mobileTab === "activity" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Activity
              </button>
            </div>
          )}

          <SheetBody className="flex flex-col gap-0 p-0 overflow-hidden">
            {/* Issue form: always visible on desktop, tab-controlled on mobile */}
            <div className={cn(
              "flex flex-col flex-1 min-h-0",
              mode === "detail" && mobileTab === "activity" && "hidden lg:flex"
            )}>
              {issueFormContent}
            </div>

            {/* Mobile timeline view */}
            {mode === "detail" && !isTodoDraft && mobileTab === "activity" && (
              <div className="flex flex-col flex-1 min-h-0 lg:hidden">
                <div className="flex-1 min-h-0 overflow-y-auto thin-scrollbar px-3 py-4 space-y-3">
                  {timelineContent}
                </div>
                {commentInput && (
                  <div className="shrink-0 border-t px-3 py-3">
                    {commentInput}
                  </div>
                )}
              </div>
            )}
          </SheetBody>

          {/* Footer — create mode only */}
          {mode === "create" && (
            <SheetFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!title.trim() || submitting}
              >
                {submitting && <Loader2 className="mr-2 size-3.5 animate-spin" />}
                <Kbd className="mr-1 hidden sm:inline-flex bg-background/20 text-inherit opacity-60">⇧ + ⏎</Kbd>
                Create
              </Button>
            </SheetFooter>
          )}
        </div>
      </SheetContent>

      {/* Dispatch confirmation dialog for todo draft issues */}
      <ConfirmDialog
        open={!!confirmAgent}
        onOpenChange={(open) => { if (!open) setConfirmAgent(null); }}
        title="Run issue?"
        description={`This issue will be assigned to ${confirmAgent?.name ?? "the agent"} and start running immediately.`}
        confirmLabel="Run"
        loadingLabel="Running..."
        confirmVariant="default"
        loading={dispatching}
        onConfirm={async () => {
          if (!confirmAgent || !issue) return;
          setDispatching(true);
          try {
            await updateIssue(workspaceId, issue.id, { agent_id: confirmAgent.id });
            setConfirmAgent(null);
            onDispatched?.(issue.id);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to dispatch issue");
            setConfirmAgent(null);
          } finally {
            setDispatching(false);
          }
        }}
      />
    </Sheet>
  );
}
