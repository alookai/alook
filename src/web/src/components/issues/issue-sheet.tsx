"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Check,
  CircleDot,
  File as FileIcon,
  GitBranch,
  Loader2,
  MessageSquare,
  Trash2,
  User,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import type { Agent, Artifact, Issue, IssueComment, Message, TaskApi } from "@alook/shared";
import { isTerminalIssueStatus } from "@alook/shared";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";

// --- Constants ---

const MIN_WIDTH = 320;
const MAX_WIDTH_RATIO = 0.8;

const GHOST_CONTROL =
  "h-7 border-0 bg-transparent px-1.5 text-xs text-foreground hover:bg-accent transition-colors -ml-1.5";

const GHOST_SELECT = cn(
  GHOST_CONTROL,
  "rounded-md outline-none focus-visible:bg-accent focus-visible:ring-0 appearance-none pr-6"
);

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
  const email = agent.email_handle ? `${agent.email_handle}@alook.ai` : "";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AgentAvatar agent={agent} size={size} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
          <span className="shrink-0 text-xs text-muted-foreground">
            {artifact.size < 1024
              ? `${artifact.size} B`
              : artifact.size < 1024 * 1024
                ? `${(artifact.size / 1024).toFixed(1)} KB`
                : `${(artifact.size / (1024 * 1024)).toFixed(1)} MB`}
          </span>
        </a>
      ))}
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
  taskLatestText?: string;
  submitting?: boolean;
  saving?: boolean;
  deleting?: boolean;
  defaultAgentId?: string;
  slug: string;
  workspaceId: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  draft?: { title: string; description: string; agentId: string };
  onDraftChange?: (draft: { title: string; description: string; agentId: string }) => void;
  onCreate?: (values: { agent_id?: string; title: string; description: string }) => Promise<void>;
  onUpdate?: (issueId: string, patch: { title?: string; description?: string }) => Promise<void>;
  onStatusChange?: (issueId: string, status: string) => Promise<void>;
  onDelete?: (issueId: string) => void;
  onCommented?: () => void;
}

export function IssueSheet({
  open,
  onOpenChange,
  agents,
  issue,
  detail,
  detailLoading,
  activeTask,
  taskLatestText,
  submitting,
  saving,
  deleting,
  defaultAgentId,
  slug,
  workspaceId,
  width = 448,
  onWidthChange,
  draft,
  onDraftChange,
  onCreate,
  onUpdate,
  onStatusChange,
  onDelete,
  onCommented,
}: IssueSheetProps) {
  const mode = issue ? "detail" : "create";

  // Local editing state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState(defaultAgentId ?? "");
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [commentContent, setCommentContent] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const isTaskActive = activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);

  // Seed state on open/issue change
  useEffect(() => {
    if (!open) return;
    if (issue) {
      setTitle(issue.title);
      setDescription(issue.description ?? "");
    } else {
      setTitle(draft?.title ?? "");
      setDescription(draft?.description ?? "");
      setAgentId(draft?.agentId ?? defaultAgentId ?? "");
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
  }, [detail?.messages?.length, detail?.comments?.length]);

  // Dirty tracking (detail mode)
  const dirty = mode === "detail" && issue
    ? title !== issue.title || description !== (issue.description ?? "")
    : false;

  // --- Title auto-resize ---
  const resizeTitle = useCallback((el?: HTMLTextAreaElement | null) => {
    const target = el ?? titleRef.current;
    if (!target) return;
    target.style.height = "auto";
    target.style.height = `${target.scrollHeight}px`;
  }, []);

  useEffect(() => {
    requestAnimationFrame(() => resizeTitle());
  }, [title, resizeTitle]);

  // --- Drag handle ---
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const maxW = window.innerWidth * MAX_WIDTH_RATIO;
    const newWidth = Math.min(maxW, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
    onWidthChange?.(newWidth);
  }, [onWidthChange]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // --- Handlers ---
  const handleCreate = async () => {
    if (!title.trim() || submitting) return;
    await onCreate?.({ agent_id: agentId || undefined, title: title.trim(), description: description.trim() });
  };

  const handleSave = async () => {
    if (!issue || !dirty || saving) return;
    const patch: { title?: string; description?: string } = {};
    if (title !== issue.title) patch.title = title.trim();
    if (description !== (issue.description ?? "")) patch.description = description.trim();
    await onUpdate?.(issue.id, patch);
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

  // Shift+Enter capture handler (skip when inside comment textarea)
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const onKeyDownCapture = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) {
      if (commentRef.current && commentRef.current.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "create") handleCreate();
      else handleSave();
    }
  }, [mode, title, description, agentId, issue, dirty, submitting, saving]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter on title → focus description
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const editor = descriptionRef.current?.querySelector('[contenteditable="true"]') as HTMLElement | null;
      editor?.focus();
    }
  };

  const selectedAgent = agents.find((a) => a.id === agentId) ?? null;
  const detailAgent = issue?.agent_id ? agents.find((a) => a.id === issue.agent_id) ?? null : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:rounded-xl data-[side=right]:sm:border"
        style={{ width: `min(${width}px, 100vw)`, maxWidth: "none" }}
      >
        {/* Resize drag handle */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onLostPointerCapture={onPointerUp}
          className="hidden sm:block absolute -left-px top-0 bottom-0 w-1.5 cursor-col-resize z-10 hover:bg-primary/20 active:bg-primary/30 transition-colors rounded-l-xl"
        />

        {/* Hidden accessible title */}
        <SheetTitle className="sr-only">
          {mode === "create" ? "New Issue" : (issue?.title ?? "Issue")}
        </SheetTitle>

        <div className="flex flex-1 min-h-0 flex-col" onKeyDownCapture={onKeyDownCapture}>
          <SheetBody className="flex flex-col gap-0 p-0 overflow-hidden">
            {/* Title */}
            <div className="shrink-0 px-2 sm:px-3 pt-5 pb-1">
              <textarea
                ref={(el) => {
                  titleRef.current = el;
                  resizeTitle(el);
                }}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  resizeTitle(e.target);
                }}
                onKeyDown={onTitleKeyDown}
                placeholder={mode === "create" ? "New issue" : "Untitled"}
                autoFocus={mode === "create"}
                rows={1}
                className="w-full resize-none overflow-hidden rounded-none border-0 bg-transparent px-0 py-1 font-news text-2xl md:text-3xl font-medium leading-[1.2] tracking-tight shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/40 placeholder:font-normal"
              />
            </div>

            {/* Properties */}
            <div className="shrink-0 space-y-1.5 px-2 sm:px-3 py-2">
              {/* Agent row */}
              <PropertyRow icon={<User className="size-3.5" />}>
                {mode === "create" ? (
                  <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          disabled={submitting}
                          className={cn(GHOST_CONTROL, "flex items-center gap-1.5 rounded-md")}
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
                      <button
                        type="button"
                        onClick={() => { setAgentId(""); setAssigneeOpen(false); }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <span className="text-muted-foreground">None (unassigned)</span>
                        {!agentId ? <Check className="size-3.5 shrink-0" /> : null}
                      </button>
                      {agents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => { setAgentId(agent.id); setAssigneeOpen(false); }}
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
                  <select
                    value={issue.status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    className={GHOST_SELECT}
                  >
                    {SELECTOR_STATUSES.map((s) => (
                      <option key={s} value={s}>{statusLabel(s)}</option>
                    ))}
                  </select>
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
                    href={`/w/${slug}/threads/${detail.traceId}`}
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
                "px-2 sm:px-3 py-2",
                mode === "create" ? "shrink-0" : "shrink-0 max-h-48 overflow-y-auto thin-scrollbar"
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
                <AttachmentList artifacts={detail.artifacts} workspaceId={workspaceId} />
              </div>
            )}

            {/* Timeline (detail mode only) */}
            {mode === "detail" && (
              <div
                ref={timelineRef}
                className="flex-1 min-h-0 overflow-y-auto thin-scrollbar border rounded-lg mx-2 sm:mx-3 mb-3 px-4 py-4 space-y-3"
              >
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
                      <div className="absolute left-[5px] top-2 bottom-2 w-px bg-border" />
                      <div className="space-y-3">
                        {timeline.map((item) => (
                          <div key={item.id} className="relative">
                            <div className="absolute -left-4 top-2.5 size-2.5 rounded-full border-2 border-background bg-muted-foreground/40" />
                            {item.kind === "event"
                              ? <MessageRow message={item.data} />
                              : <CommentRow comment={item.data} agents={agents} />}
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
            )}

            {/* Comment input (detail mode, non-terminal, no active task) */}
            {mode === "detail" && issue && !isTaskActive && !isTerminalIssueStatus(issue.status) && (
              <div className="shrink-0 px-2 sm:px-3 pb-3 space-y-2">
                <Textarea
                  ref={commentRef}
                  placeholder="Leave a comment..."
                  value={commentContent}
                  onChange={(e) => setCommentContent(e.target.value)}
                  className="min-h-[60px] text-sm"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCommentSubmit(); }}
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleCommentSubmit} disabled={!commentContent.trim() || commentSubmitting}>
                    {commentSubmitting ? "Sending..." : "Comment"}
                  </Button>
                </div>
              </div>
            )}
          </SheetBody>

          {/* Footer */}
          <SheetFooter className={cn(mode === "detail" && "sm:justify-between")}>
            {mode === "create" ? (
              <>
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
                  {submitting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  <kbd className="mr-1 hidden sm:inline-flex items-center gap-0.5 font-sans font-medium leading-none opacity-60">
                    <span>&#x21E7;</span><span>+</span><span>&#x23CE;</span>
                  </kbd>
                  Create
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => issue && onDelete?.(issue.id)}
                  disabled={deleting || saving}
                >
                  <Trash2 className="mr-1.5 size-3.5" />
                  Delete
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={!dirty || !title.trim() || saving}
                  >
                    {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                    <kbd className="mr-1 hidden sm:inline-flex items-center gap-0.5 font-sans font-medium leading-none opacity-60">
                      <span>&#x21E7;</span><span>+</span><span>&#x23CE;</span>
                    </kbd>
                    Save
                  </Button>
                </div>
              </>
            )}
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  );
}
