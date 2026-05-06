"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, ExternalLink, File as FileIcon, Loader2, MessageSquare, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import type { Agent, Artifact, Issue, Message, WsMessage } from "@alook/shared";
import { useWorkspace } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";
import { createIssue, deleteIssue, getIssue, listIssues } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody } from "@/components/ui/sheet";
import { AvatarRenderer, parseAvatarUrl } from "@/components/avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Streamdown } from "streamdown";

// TODO: re-enable when Codex CLI fixes image_url serialization bug
// const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
// const MAX_ATTACHMENTS = 10;

const ACTIVE_COLUMNS = [
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
] as const;

const TERMINAL_STATUSES = ["done", "closed", "canceled", "failed"];

function statusLabel(status: string) {
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

function AgentIdentity({ agent, muted = false }: { agent: Agent; muted?: boolean }) {
  const email = agent.email_handle ? `${agent.email_handle}@alook.ai` : "";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <AgentAvatar agent={agent} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className={cn("truncate text-sm font-medium", muted && "text-muted-foreground")}>{agent.name}</div>
        {email ? (
          <div className="truncate text-xs text-muted-foreground">{email}</div>
        ) : null}
      </div>
    </div>
  );
}

function BoardAgentCell({
  agent,
}: {
  agent: Agent;
}) {
  const email = agent.email_handle ? `${agent.email_handle}@alook.ai` : "";
  const isOnline = agent.status === "working" || agent.status === "idle";

  return (
    <div className="flex min-w-0 items-center gap-3 bg-background/25 px-3 py-3">
      <div className="relative shrink-0">
        <AgentAvatar agent={agent} size={32} />
        <span className={cn(
          "absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-background",
          agent.status === "working" ? "bg-amber-400" : isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
        )} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{agent.name}</div>
        {email ? (
          <div className="truncate text-[11px] text-muted-foreground">{email}</div>
        ) : agent.description ? (
          <div className="line-clamp-1 text-[11px] text-muted-foreground">{agent.description}</div>
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
  agentName,
  compact = false,
}: {
  issue: Issue;
  selected: boolean;
  onClick: () => void;
  onDelete?: () => void;
  agentName?: string;
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
            {agentName ? <span className="truncate">{agentName}</span> : <span />}
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

function MessageRow({ message }: { message: Message }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/55 p-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="capitalize">{message.role}</span>
        <span>{new Date(message.created_at).toLocaleString()}</span>
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
        <Streamdown>{message.content}</Streamdown>
      </div>
    </div>
  );
}

function AttachmentList({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) return null;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {artifacts.map((artifact) => (
          <div key={artifact.id} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/55 px-3 py-2 text-sm sm:max-w-72">
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{artifact.filename}</div>
              <div className="text-xs text-muted-foreground">{formatFileSize(artifact.size)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function IssuesPage() {
  const { workspaceId, slug } = useWorkspace();
  const { agents, loading: agentsLoading, subscribeWs } = useAgentContext();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ issue: Issue; messages: Message[]; artifacts: Artifact[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", agentId: "" });

  const completedIssues = useMemo(
    () => issues.filter((issue) => TERMINAL_STATUSES.includes(issue.status)),
    [issues]
  );
  const activeIssues = useMemo(
    () => issues.filter((issue) => !TERMINAL_STATUSES.includes(issue.status)),
    [issues]
  );
  const selectedFormAgent = agents.find((agent) => agent.id === form.agentId) ?? null;

  function agentName(agentId: string) {
    return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
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

  useEffect(() => {
    if (!form.agentId && agents.length > 0) {
      setForm((prev) => ({ ...prev, agentId: agents[0].id }));
    }
  }, [agents, form.agentId]);

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

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "conversation.message" && detailConvId && msg.conversationId === detailConvId) {
        setDetail((prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === msg.message.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg.message] };
        });
        if (msg.message.role === "event" && msg.message.content.startsWith("Issue status changed:")) {
          const match = msg.message.content.match(/-> (\w+)/);
          if (match) {
            const newStatus = match[1] as Issue["status"];
            setDetail((prev) => prev ? { ...prev, issue: { ...prev.issue, status: newStatus } } : prev);
            setIssues((prev) => prev.map((i) => i.conversation_id === detailConvId ? { ...i, status: newStatus, updated_at: msg.message.created_at } : i));
          }
        }
      }
      if (msg.type === "task.updated" && (msg.status === "running" || msg.status === "completed" || msg.status === "failed")) {
        reload();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailConvId, subscribeWs]);

  async function handleCreate() {
    if (!form.title.trim() || !form.agentId) return;
    setCreating(true);
    try {
      const res = await createIssue(workspaceId, {
        agent_id: form.agentId,
        title: form.title.trim(),
        description: form.description.trim(),
        // files: attachments, // TODO: disabled until Codex CLI fixes image_url serialization bug
      });
      setIssues((prev) => [res.issue, ...prev]);
      setDialogOpen(false);
      setForm({ title: "", description: "", agentId: form.agentId });
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

  // TODO: attachment functions disabled until Codex CLI fixes image_url serialization bug
  // function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) { ... }
  // function removeAttachment(index: number) { ... }

  function resetDraft(nextAgentId = form.agentId) {
    setForm({ title: "", description: "", agentId: nextAgentId || agents[0]?.id || "" });
  }

  const boardLoading = loading || agentsLoading;
  const activeCount = activeIssues.length;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background/30">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-normal">Issues</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{activeCount} active</span>
            <span className="text-border">/</span>
            <span>{completedIssues.length} completed</span>
            <span className="text-border">/</span>
            <span>{agents.length} agents</span>
          </div>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open && !creating) resetDraft();
          }}
        >
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
                        disabled={agents.length === 0 || creating}
                        className="-ml-1.5 flex h-7 min-w-0 flex-1 items-center rounded-md bg-muted/40 px-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                      />
                    }
                  >
                    {selectedFormAgent ? (
                      <AgentIdentity agent={selectedFormAgent} />
                    ) : (
                      <span className="text-sm text-muted-foreground">Select an agent</span>
                    )}
                  </PopoverTrigger>
                  <PopoverContent align="start" className="max-h-64 w-72 overflow-y-auto p-1">
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => {
                          setForm((prev) => ({ ...prev, agentId: agent.id }));
                          setAssigneeOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <AgentIdentity agent={agent} />
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
                  disabled={creating || !form.title.trim() || !form.agentId}
                >
                  {creating ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Plus className="mr-1 size-3" />}
                  Create
                </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="hidden min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] lg:grid">
        <div className="min-w-0 overflow-x-auto overflow-y-auto thin-scrollbar p-4">
          <div className="min-w-190 overflow-hidden rounded-lg border border-border/60 bg-card/60">
            <div className="grid grid-cols-[240px_repeat(3,minmax(180px,1fr))] border-b border-border/60 bg-muted/30 text-xs font-medium text-muted-foreground">
              <div className="px-3 py-2">Agent</div>
              {ACTIVE_COLUMNS.map((col) => (
                <div key={col.id} className="flex items-center justify-between border-l border-border/60 px-3 py-2">
                  <span>{col.label}</span>
                  <span>{activeIssues.filter((issue) => issue.status === col.id).length}</span>
                </div>
              ))}
            </div>
            {boardLoading ? (
              <div className="grid grid-cols-[240px_repeat(3,minmax(180px,1fr))] gap-0 p-3">
                {Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="m-2 h-20" />)}
              </div>
            ) : agents.length === 0 ? (
              <div className="p-8 text-sm text-muted-foreground">No agents in this workspace.</div>
            ) : (
              agents.map((agent) => (
                <div key={agent.id} className="grid min-h-24 grid-cols-[240px_repeat(3,minmax(180px,1fr))] border-b border-border/40 last:border-b-0">
                  <BoardAgentCell agent={agent} />
                  {ACTIVE_COLUMNS.map((col) => {
                    const columnIssues = activeIssues.filter((issue) => issue.agent_id === agent.id && issue.status === col.id);
                    return (
                      <div key={col.id} className="min-h-24 space-y-2 border-l border-border/40 p-2">
                        {columnIssues.length === 0 ? (
                          <div className="flex h-full min-h-14 items-center justify-center rounded-lg border border-dashed border-border/45 text-xs text-muted-foreground/70">
                            Empty
                          </div>
                        ) : (
                          columnIssues.map((issue) => (
                            <IssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} />
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>

        <aside className="min-h-0 border-l border-border/60 bg-muted/20">
          <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-border/60 px-4 py-3">
              <div className="flex items-center justify-between gap-2 text-sm font-medium">
                <span className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-muted-foreground" />
                Completed
                </span>
                <span className="text-xs text-muted-foreground">{completedIssues.length}</span>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto thin-scrollbar p-3">
              {completedIssues.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">No completed issues.</div>
              ) : (
                completedIssues.map((issue) => (
                  <IssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} agentName={agentName(issue.agent_id)} compact />
                ))
              )}
            </div>
          </div>
        </aside>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar p-3 lg:hidden">
        {boardLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
          </div>
        ) : agents.length === 0 ? (
          <div className="rounded-lg border border-border/60 bg-card/60 p-8 text-center text-sm text-muted-foreground">No agents in this workspace.</div>
        ) : (
          <div className="space-y-4">
            {agents.map((agent) => {
              const agentIssues = activeIssues.filter((issue) => issue.agent_id === agent.id);
              return (
                <section key={agent.id} className="rounded-lg border border-border/60 bg-card/60">
                  <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <AgentIdentity agent={agent} />
                    </div>
                    <Badge variant="outline" className="shrink-0">{agentIssues.length} active</Badge>
                  </div>
                  <div className="space-y-3 p-3">
                    {ACTIVE_COLUMNS.map((col) => {
                      const columnIssues = agentIssues.filter((issue) => issue.status === col.id);
                      return (
                        <div key={col.id} className="space-y-2">
                          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                            <span>{col.label}</span>
                            <span>{columnIssues.length}</span>
                          </div>
                          {columnIssues.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border/45 px-3 py-4 text-center text-xs text-muted-foreground/70">Empty</div>
                          ) : (
                            columnIssues.map((issue) => (
                              <IssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} compact />
                            ))
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            <section className="rounded-lg border border-border/60 bg-card/60">
              <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 text-sm font-medium">
                <span className="flex items-center gap-2"><CheckCircle2 className="size-4 text-muted-foreground" />Completed</span>
                <Badge variant="outline">{completedIssues.length}</Badge>
              </div>
              <div className="space-y-2 p-3">
                {completedIssues.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/45 px-3 py-4 text-center text-xs text-muted-foreground/70">No completed issues.</div>
                ) : (
                  completedIssues.map((issue) => (
                    <IssueCard key={issue.id} issue={issue} selected={selectedId === issue.id} onClick={() => openIssue(issue.id)} onDelete={() => handleDeleteIssue(issue.id)} agentName={agentName(issue.agent_id)} compact />
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </div>

      <Sheet open={!!selectedId} onOpenChange={(open) => { if (!open) { setSelectedId(null); setDetail(null); } }}>
        <SheetContent side="right" showCloseButton>
          <SheetHeader>
            <SheetTitle>
              {detailLoading || !detail ? (
                <Skeleton className="h-5 w-56" />
              ) : (
                <span className="flex items-center gap-1.5">
                  <Badge variant={detail.issue.status === "in_progress" ? "default" : "outline"} className="shrink-0 text-[10px] px-1.5 py-0">
                    {detail.issue.status === "in_progress" && <Loader2 className="mr-1 size-3 animate-spin" />}
                    {statusLabel(detail.issue.status)}
                  </Badge>
                  <span className="line-clamp-2 text-sm font-semibold">{detail.issue.title}</span>
                </span>
              )}
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            {detailLoading || !detail ? (
              <div className="space-y-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-16" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="prose prose-sm dark:prose-invert max-w-none rounded-lg border border-border/60 bg-background/55 p-3">
                  <Streamdown>{detail.issue.description || "No description."}</Streamdown>
                </div>
                <AttachmentList artifacts={detail.artifacts ?? []} />
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <MessageSquare className="size-4 text-muted-foreground" />
                      Conversation
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Link
                            href={`/w/${slug}/agents/${detail.issue.agent_id}?conv=${detail.issue.conversation_id}`}
                            aria-label="Open chat"
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          />
                        }
                      >
                        <ExternalLink className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent side="left">Open chat</TooltipContent>
                    </Tooltip>
                  </div>
                  {detail.messages.length === 0 ? (
                    <div className="text-xs text-muted-foreground">No messages yet.</div>
                  ) : (
                    detail.messages.map((message) => <MessageRow key={message.id} message={message} />)
                  )}
                </div>
              </div>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
