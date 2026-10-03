"use client";

import { useAtom, useCreateAtom, useCreateStore, useSelector } from "@tanstack/react-store";
import { IssueAttachmentList } from "./issue-attachment-list";
import { useCallback, useEffect, useRef } from "react";
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
import { isTerminalIssueStatus, toAlookAddress } from "@alook/shared";
import type { TraceTask } from "@/lib/api";
import { useWorkspaceOwner, captureWorkspaceOwner } from "@/contexts/workspace-context";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { useIssueCommand, usePendingIssueChanges } from "@/hooks/workspace/use-issue-command";
import { AgentAvatar } from "@/components/avatar";
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

function AgentIdentity({ agent, size = 24 }: { agent: Agent; size?: number }) {
  const email = agent.email_handle ? toAlookAddress(agent.email_handle) : "";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AgentAvatar name={agent.name} avatarUrl={agent.avatar_url} seed={agent.id} size={size} />
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

type IssueSaveIntent = {
  id: string;
  patch: { title?: string; description?: string };
  token: ReturnType<typeof captureWorkspaceOwner>;
  assertView: () => void;
};
type IssueDraftState = {
  id: string | null;
  title: string | null;
  description: string | null;
  pending: IssueSaveIntent | null;
};

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
  onStatusChange,
  onCommented,
  onDispatched,
  onArtifactClick,
}: IssueSheetProps) {
  const mode = issue ? "detail" : "create";
  const owner = useWorkspaceOwner();
  const source = useWorkspaceViewSource(owner, JSON.stringify(["issue-sheet", issue?.id ?? "create"]), open && owner.workspaceId === workspaceId);
  const { mutateAsync: mutateIssue } = useIssueCommand(owner);
  const pendingCommands = usePendingIssueChanges(owner);
  const editing = useCreateStore<IssueDraftState>({ id: null, title: null, description: null, pending: null });
  const edits = useSelector(editing, (state) => state);

  // Local editing state
  const [createTitle, setCreateTitle] = useAtom(useCreateAtom(""));
  const [createDescription, setCreateDescription] = useAtom(useCreateAtom(""));
  const title = issue ? (edits.id === issue.id ? edits.title : null) ?? issue.title : createTitle;
  const description = issue ? (edits.id === issue.id ? edits.description : null) ?? issue.description ?? "" : createDescription;
  const [agentId, setAgentId] = useAtom(useCreateAtom(defaultAgentId ?? ""));
  const [assigneeOpen, setAssigneeOpen] = useAtom(useCreateAtom(false));
  const [commentContent, setCommentContent] = useAtom(useCreateAtom(""));
  const [confirmAgentId, setConfirmAgentId] = useAtom(useCreateAtom<string | null>(null));
  const confirmAgent = agents.find((agent) => agent.id === confirmAgentId) ?? null;
  const commentSubmitting = pendingCommands.some((action) => action.kind === "comment" && action.id === issue?.id);
  const dispatching = pendingCommands.some((action) => action.kind === "update" && action.id === issue?.id && action.patch.agent_id != null);

  const descriptionRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const isTaskActive = activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);
  const hasActiveTraceTasks = traceTasks?.some(t => ["queued", "dispatched", "running"].includes(t.status)) ?? false;

  // Seed state on open/issue change
  useEffect(() => {
    if (!open) return;
    setConfirmAgentId(null);
    setCommentContent("");
    if (!issue) {
      setCreateTitle(draft?.title ?? "");
      setCreateDescription(draft?.description ?? "");
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
  const flushAutoSave = useCallback(() => {
    const intent = editing.get().pending;
    if (!intent || (intent.patch.title != null && !intent.patch.title.trim())) return;
    editing.setState((state) => state.pending === intent ? { ...state, pending: null } : state);
    void mutateIssue({ action: { kind: "update", id: intent.id, patch: intent.patch }, token: intent.token }).then(() => {
      intent.assertView();
      editing.setState((state) => state.id !== intent.id ? state : {
        ...state,
        title: state.title?.trim() === intent.patch.title ? null : state.title,
        description: state.description?.trim() === intent.patch.description ? null : state.description,
      });
    }).catch((error) => {
      try { intent.assertView(); } catch { return; }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error(error instanceof Error ? error.message : "Failed to save issue");
    });
  }, [mutateIssue, editing]);

  const editField = (field: "title" | "description", value: string) => {
    if (!issue) {
      if (field === "title") setCreateTitle(value);
      else setCreateDescription(value);
      return;
    }
    source.assertActive();
    const id = issue.id;
    editing.setState((state) => {
      const current = state.id === id ? state : { id, title: null, description: null, pending: null };
      const patch = { ...current.pending?.patch, [field]: value.trim() };
      const intent = current.pending ?? { id, token: captureWorkspaceOwner(owner), assertView: source.assertActive, patch };
      return { ...current, [field]: value, pending: { ...intent, patch } };
    });
  };

  useEffect(() => {
    if (!open || !edits.pending) return;
    const timer = setTimeout(flushAutoSave, 500);
    return () => clearTimeout(timer);
  }, [edits.pending, open, flushAutoSave]);

  // Flush pending auto-save when sheet closes
  useEffect(() => {
    if (!open || !issue?.id) return;
    const id = issue.id;
    return () => { if (editing.get().pending?.id === id) flushAutoSave(); };
  }, [open, issue?.id, editing, flushAutoSave]);

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
    const original = source.assertActive;
    original();
    const content = commentContent;
    const id = issue.id;
    const token = captureWorkspaceOwner(owner);
    try {
      await mutateIssue({ action: { kind: "comment", id, content: content.trim() }, token });
      original();
      setCommentContent((current) => current === content ? "" : current);
      onCommented?.();
    } catch (error) {
      try { original(); } catch { return; }
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Failed to send comment");
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
  const [mobileTab, setMobileTab] = useAtom(useCreateAtom<"issue" | "activity">("issue"));

  // Reset tab when switching issues or modes
  useEffect(() => {
    setMobileTab("issue");
  }, [issue?.id, mode, setMobileTab]);

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
                            {t.agent && <AgentAvatar name={t.agent.name} avatarUrl={t.agent.avatarUrl} seed={t.agent.name || "?"} size={16} />}
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
          onChange={(e) => editField("title", e.target.value)}
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
                        setConfirmAgentId(agent.id);
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
          onChange={(value) => editField("description", value)}
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
          <IssueAttachmentList artifacts={detail.artifacts} workspaceId={workspaceId} onArtifactClick={onArtifactClick} />
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
        onOpenChange={(open) => { if (!open) setConfirmAgentId(null); }}
        title="Run issue?"
        description={`This issue will be assigned to ${confirmAgent?.name ?? "the agent"} and start running immediately.`}
        confirmLabel="Run"
        loadingLabel="Running..."
        confirmVariant="default"
        loading={dispatching}
        onConfirm={async () => {
          if (!confirmAgent || !issue) return;
          const original = source.assertActive;
          original();
          const id = issue.id;
          const token = captureWorkspaceOwner(owner);
          try {
            await mutateIssue({ action: { kind: "update", id, patch: { agent_id: confirmAgent.id } }, token });
            original();
            setConfirmAgentId(null);
            onDispatched?.(id);
          } catch (e) {
            try { original(); } catch { return; }
            if (e instanceof DOMException && e.name === "AbortError") return;
            toast.error(e instanceof Error ? e.message : "Failed to dispatch issue");
            setConfirmAgentId(null);
          }
        }}
      />
    </Sheet>
  );
}
