"use client";

import { useObservedQueryRegion } from "@/lib/observability/query-regions"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useArtifactClick } from "@/components/use-artifact-click";
import { useCallback, useEffect, useMemo } from "react";
import { useQuery, isCancelledError } from "@tanstack/react-query";
import { workspaceIssueListOptions, workspaceIssueOptions, workspaceTaskOptions, workspaceTraceOptions } from "@/hooks/workspace/issue-query-options";
import { useIssueCommand, usePendingIssueChanges } from "@/hooks/workspace/use-issue-command";
import { useWorkspaceViewSource } from "@/hooks/workspace/use-workspace-view-source";
import { ApiError, isAbortError } from "@/lib/errors";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { CircleDot, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";
import type { Agent, Artifact, Issue } from "@alook/shared";
import { useWorkspaceOwner, captureWorkspaceOwner } from "@/contexts/workspace-context";
import { useAgentContext } from "@/contexts/agent-context";

import type { IssueListItem } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentAvatar } from "@/components/avatar";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, useDraggable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { IssueSheet } from "@/components/issues/issue-sheet";
import { trackIssueCreated, trackIssueStatusChanged } from "@/lib/analytics";
import { ArtifactSheet } from "@/components/agent-chat/artifact-sheet";
import { computeArtifactVersions } from "@/components/artifact-content-renderer";


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
              <span className="flex shrink-0 items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
                <Loader2 className="size-2.5 animate-spin" /> Working
              </span>
            )}
            {issue.status === "review" && (
              <span className="shrink-0 rounded bg-yellow-500/10 px-2 py-1 text-[10px] font-medium text-yellow-600 dark:text-yellow-400">Review</span>
            )}
            {issue.status === "failed" && (
              <span className="shrink-0 rounded bg-destructive/10 px-2 py-1 text-[10px] font-medium text-destructive">Failed</span>
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
                  <span key={a.id} className={cn("rounded-full border-2 border-background", i > 0 && "-ml-2")}>
                    <AgentAvatar name={a.name} avatarUrl={a.avatar_url} seed={a.id} size={16} />
                  </span>
                ))}
                {threadAgents.length > 3 && (
                  <span className="flex items-center justify-center rounded-full border-2 border-background bg-muted text-[9px] font-medium text-muted-foreground -ml-2" style={{ width: 16, height: 16 }}>
                    +{threadAgents.length - 3}
                  </span>
                )}
              </span>
            ) : agent ? (
              <span className="flex items-center gap-1 truncate">
                <AgentAvatar name={agent.name} avatarUrl={agent.avatar_url} seed={agent.id} size={14} />
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
            <Trash2 className="size-3.5 mr-2" />
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

  const owner = useWorkspaceOwner();
  const { workspaceId, slug } = owner;
  const { agents, loading: agentsLoading } = useAgentContext();
  const scope = owner.application.userId + ":" + workspaceId;
  const [recentAgentId, setRecentAgentId] = useLocalStorage<string>("issue-recent-agent-id-" + scope, "");
  const [draft, setDraft] = useLocalStorage<{ title: string; description: string; agentId: string }>("issue-draft-" + scope, { title: "", description: "", agentId: "" });
  const [showCompleted, setShowCompleted] = useLocalStorage<boolean>("issues-show-completed-" + owner.application.userId, true);
  const [sheetOpen, setSheetOpen] = useAtom(useCreateAtom(false));
  const selection = useCreateAtom<string | null>(null);
  const [selectedId, setSelectedId] = useAtom(selection);
  const [activeDragId, setActiveDragId] = useAtom(useCreateAtom<string | null>(null));
  const [artifactSheetOpen, setArtifactSheetOpen] = useAtom(useCreateAtom(false));
  const [selectedArtifactId, setSelectedArtifactId] = useAtom(useCreateAtom<string | null>(null));
  const source = useWorkspaceViewSource(owner, JSON.stringify(["issue-board", selectedId, sheetOpen]), true);
  const listQuery = useQuery(workspaceIssueListOptions(owner));
  const issueQuery = useQuery({ ...workspaceIssueOptions(owner, sheetOpen ? selectedId ?? "__none__" : "__none__"), enabled: sheetOpen && !!selectedId });
  const { mutateAsync: mutateIssue } = useIssueCommand(owner);
  const pending = usePendingIssueChanges(owner);
  const projectIssue = useCallback((issue: IssueListItem) => pending.reduce((current, action) => action.kind === "update" && action.id === current.id ? { ...current, ...action.patch } : current, issue), [pending]);
  const issues = useMemo(() => (listQuery.data ?? []).filter((row) => !pending.some((action) => action.kind === "delete" && action.id === row.id)).map(projectIssue), [listQuery.data, pending, projectIssue]);
  const detail = useMemo(() => issueQuery.data ? { ...issueQuery.data, issue: { ...issueQuery.data.issue, ...projectIssue(issueQuery.data.issue) } } : null, [issueQuery.data, projectIssue]);
  const detailLoading = issueQuery.isPending && !!selectedId && sheetOpen;
  const taskId = detail?.issue.latest_task_id;
  const traceId = detail?.issue.trace_id;
  const activeTask = useQuery({ ...workspaceTaskOptions(owner, taskId ?? "__none__"), enabled: sheetOpen && !!taskId }).data ?? null;
  const traceTasks = useQuery({ ...workspaceTraceOptions(owner, traceId ?? "__none__"), enabled: sheetOpen && !!traceId }).data?.tasks ?? null;
  const loading = listQuery.isPending;
  useObservedQueryRegion("issues", listQuery, issues.length);
  useObservedQueryRegion("issue_detail", issueQuery, undefined, sheetOpen && !!selectedId);
  const creating = pending.some((action) => action.kind === "create");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const issueArtifacts = useMemo(() => detail?.artifacts ?? [], [detail?.artifacts]);
  const selectedArtifact = issueArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const { versionMap: artifactVersionMap, duplicateFilenames: artifactDuplicateFilenames } = useMemo(() => computeArtifactVersions(issueArtifacts), [issueArtifacts]);
  const previewArtifact = useCallback((artifact: Artifact) => { setSelectedArtifactId(artifact.id); setArtifactSheetOpen(true); }, [setSelectedArtifactId, setArtifactSheetOpen]);
  const handleArtifactClick = useArtifactClick(workspaceId, previewArtifact);

  const openIssue = useCallback((id: string) => {
    source.assertActive();
    setSelectedId(id);
    setSheetOpen(true);
  }, [source, setSelectedId, setSheetOpen]);
  const handleSheetOpenChange = useCallback((open: boolean) => {
    setSheetOpen(open);
    if (!open) setSelectedId(null);
  }, [setSheetOpen, setSelectedId]);
  useEffect(() => {
    if (!issueQuery.error || isAbortError(issueQuery.error) || isCancelledError(issueQuery.error)) return;
    try { source.assertActive(); } catch { return; }
    if (issueQuery.error instanceof ApiError && issueQuery.error.status === 404) handleSheetOpenChange(false);
    else toast.error(issueQuery.error instanceof Error ? issueQuery.error.message : "Failed to load issue");
  }, [issueQuery.error, source.assertActive, handleSheetOpenChange, source]);

  const handleCreate = useCallback(async (values: { agent_id?: string; title: string; description: string }) => {
    const assertView = source.assertActive;
    try {
      assertView();
      const issue = await mutateIssue({ action: { kind: "create", values }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
      if (!issue) return;
      trackIssueCreated({ agent_id: values.agent_id ?? "" });
      if (values.agent_id) setRecentAgentId(values.agent_id);
      setDraft({ title: "", description: "", agentId: "" });
      setSelectedId(issue.id);
      setSheetOpen(true);
      toast.success("Issue created");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to create issue");
    }
  }, [owner, source, mutateIssue, setRecentAgentId, setDraft, setSelectedId, setSheetOpen]);

  const handleUpdate = useCallback(async (id: string, patch: { title?: string; description?: string }) => {
    const assertView = source.assertActive;
    try {
      assertView();
      await mutateIssue({ action: { kind: "update", id, patch }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to update issue");
    }
  }, [owner, source, mutateIssue]);

  const handleStatusChange = useCallback(async (id: string, status: string, method: "button" | "drag" = "button") => {
    const issue = issues.find((row) => row.id === id);
    if (!issue || issue.status === status) return;
    const assertView = source.assertActive;
    try {
      assertView();
      trackIssueStatusChanged({ from: issue.status, to: status, method });
      await mutateIssue({ action: { kind: "update", id, patch: { status: status as Issue["status"] } }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to update issue status");
    }
  }, [owner, issues, source, mutateIssue]);

  const handleDeleteIssue = useCallback(async (id: string) => {
    const assertView = source.assertActive;
    try {
      assertView();
      await mutateIssue({ action: { kind: "delete", id }, token: captureWorkspaceOwner(owner), assertActive: Object.assign(() => assertView(), { signal: source.signal }) });
      assertView();
      if (selection.get() === id) handleSheetOpenChange(false);
      toast.success("Issue deleted");
    } catch (error) {
      try { assertView(); } catch { return; }
      if (!isAbortError(error)) toast.error(error instanceof Error ? error.message : "Failed to delete issue");
    }
  }, [owner, source, mutateIssue, selection, handleSheetOpenChange]);

  function handleDragStart(event: DragStartEvent) { setActiveDragId(event.active.id as string); }
  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const issue = issues.find((row) => row.id === active.id), column = COLUMNS.find((row) => row.id === over.id);
    if (!issue || !column || (column.statuses as readonly string[]).includes(issue.status)) return;
    if (issue.status === "todo" && !issue.agent_id && column.id !== "todo" && column.id !== "completed") { toast.error("Assign an agent first to run this issue"); return; }
    await handleStatusChange(issue.id, column.id === "completed" ? "done" : column.id, "drag");
  }
  const boardLoading = loading || agentsLoading;
  const selectedIssue = selectedId ? detail?.issue ?? issues.find((i) => i.id === selectedId) ?? null : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background/30">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-normal">Issues</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="w-full sm:w-auto" onClick={() => { setSelectedId(null); setSheetOpen(true); }}>
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
                      <div className="flex items-center gap-2">
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
                                  className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground disabled:opacity-40"
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
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-2">
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
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{columnIssues.length}</Badge>
                      {col.id === "completed" && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Hide completed column"
                                onClick={() => setShowCompleted(false)}
                                className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground"
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
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/30"
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
        onDispatched={openIssue}
        onArtifactClick={handleArtifactClick}
      />

      <ArtifactSheet
        open={artifactSheetOpen}
        onOpenChange={(v) => {
          setArtifactSheetOpen(v);
          if (!v) setSelectedArtifactId(null);
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
