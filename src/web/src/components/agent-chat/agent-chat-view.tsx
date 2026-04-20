"use client";

import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { TaskStream } from "@/components/task-stream";
import {
  getOrCreateAgentConversation,
  listMessages,
  sendMessage,
  getTask,
  getTaskMessages,
  getActiveTask,
  deleteConversation,
  listArtifacts,
} from "@/lib/api";
import type { Artifact, Conversation, Message, TaskApi as Task, TaskMessage, WsMessage } from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUp, Box, FileText, Loader2, RotateCcw } from "lucide-react";
import { ArtifactSheet, formatSize } from "@/components/agent-chat/artifact-sheet";
import { isPreviewable, getArtifactUrl } from "@/components/artifact-content-renderer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Streamdown } from "streamdown";

const MESSAGE_LIMIT = 20;

/** Sort messages by (created_at, id) ascending — guarantees chronological order. */
export function sortMessages(msgs: Message[]): Message[] {
  return msgs.slice().sort((a, b) => {
    const cmp = a.created_at.localeCompare(b.created_at);
    if (cmp !== 0) return cmp;
    return a.id.localeCompare(b.id);
  });
}

/** Merge two message arrays by ID (latest wins), then sort chronologically. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const merged = new Map<string, Message>();
  for (const m of existing) merged.set(m.id, m);
  for (const m of incoming) merged.set(m.id, m);
  return sortMessages([...merged.values()]);
}

type TimelineItem =
  | { kind: "message"; data: Message }
  | { kind: "artifact"; data: Artifact };

function buildTimeline(messages: Message[], artifacts: Artifact[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m): TimelineItem => ({ kind: "message", data: m })),
    ...artifacts.map((a): TimelineItem => ({ kind: "artifact", data: a })),
  ];
  return items.sort((a, b) => {
    const cmp = a.data.created_at.localeCompare(b.data.created_at);
    if (cmp !== 0) return cmp;
    if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
    return a.data.id.localeCompare(b.data.id);
  });
}

function ArtifactCard({ artifact, onClick }: { artifact: Artifact; onClick: (a: Artifact) => void }) {
  return (
    <button
      onClick={() => onClick(artifact)}
      className={cn(
        "flex items-center gap-3 w-full max-w-sm rounded-lg border border-border/60 bg-muted/30",
        "px-3.5 py-2.5 text-left transition-colors duration-150",
        "hover:bg-muted/60 hover:border-border"
      )}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{artifact.filename}</p>
        <p className="text-xs text-muted-foreground">{formatSize(artifact.size)}</p>
      </div>
    </button>
  );
}

export function AgentChatView() {
  const params = useParams();
  const { workspaceId } = useWorkspace();
  const { subscribeWs } = useAgentContext();
  const agentId = params.id as string;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(`chat-draft:${agentId}`) ?? "";
  });
  const [sending, setSending] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactSheetOpen, setArtifactSheetOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);

  const timeline = useMemo(() => buildTimeline(messages, artifacts), [messages, artifacts]);

  const handleArtifactClick = useCallback((artifact: Artifact) => {
    if (isPreviewable(artifact)) {
      setSelectedArtifact(artifact);
      setArtifactSheetOpen(true);
    } else {
      window.open(getArtifactUrl(artifact.id, workspaceId, true), "_blank");
    }
  }, [workspaceId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeqRef = useRef(0);
  const pollFailures = useRef(0);
  const initialScrollDone = useRef(false);
  const loadingMoreRef = useRef(false);
  const isNearBottom = useRef(true);
  const startPollingRef = useRef<(taskId: string, conversationId: string, initialSeq?: number) => void>(null!);

  useEffect(() => {
    const key = `chat-draft:${agentId}`;
    if (input) {
      localStorage.setItem(key, input);
    } else {
      localStorage.removeItem(key);
    }
  }, [input, agentId]);

  const scrollToBottom = useCallback(() => {
    isNearBottom.current = true;
    setTimeout(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 50);
  }, []);

  // Resolve conversation (get or create) then load messages + recover active task
  useEffect(() => {
    async function load() {
      try {
        const conv = await getOrCreateAgentConversation(agentId, workspaceId);
        setConversation(conv);
        const [msgs, arts] = await Promise.all([
          listMessages(conv.id, workspaceId, { limit: MESSAGE_LIMIT }),
          listArtifacts(conv.id, workspaceId),
        ]);
        setMessages(msgs);
        setArtifacts(arts);
        setHasMore(msgs.length >= MESSAGE_LIMIT);

        // Recover active task (e.g. after page refresh)
        const task = await getActiveTask(conv.id, workspaceId);
        if (task) {
          setActiveTask(task);
          const tmsgs = await getTaskMessages(task.id, workspaceId);
          if (tmsgs.length > 0) {
            setTaskMessages(tmsgs);
            lastSeqRef.current = Math.max(...tmsgs.map((m) => m.seq));
          }
          if (task.status !== "completed" && task.status !== "failed") {
            startPollingRef.current(task.id, conv.id, lastSeqRef.current);
          }
        }
      } catch {
        toast.error("Failed to load conversation");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [agentId, workspaceId]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && messages.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true;
      setTimeout(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      }, 50);
    }
  }, [loading, messages.length]);

  // Auto-scroll when task badge appears or new task steps arrive
  const taskStatus = activeTask?.status;
  useEffect(() => {
    const isRunning = taskStatus === "running" || taskStatus === "queued";
    if (isRunning && isNearBottom.current) {
      scrollToBottom();
    }
  }, [taskMessages.length, taskStatus, scrollToBottom]);

  const loadOlderMessages = useCallback(async () => {
    if (!conversation || loadingMoreRef.current || !hasMore) return;
    const oldest = messages[0];
    if (!oldest) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;

    try {
      const older = await listMessages(conversation.id, workspaceId, {
        limit: MESSAGE_LIMIT,
        before: oldest.created_at,
        beforeId: oldest.id,
      });
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      setHasMore(older.length >= MESSAGE_LIMIT);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const unique = older.filter((m) => !existingIds.has(m.id));
        return [...unique, ...prev];
      });

      // Restore scroll position so content doesn't jump
      requestAnimationFrame(() => {
        if (el) {
          const newScrollHeight = el.scrollHeight;
          el.scrollTop = newScrollHeight - prevScrollHeight;
        }
      });
    } catch {
      toast.error("Failed to load older messages");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [conversation, workspaceId, messages, hasMore]);

  // Auto-load older messages when content doesn't overflow (scroll can't trigger)
  useEffect(() => {
    if (loading || !hasMore || loadingMoreRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      if (el.scrollHeight <= el.clientHeight) {
        loadOlderMessages();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [loading, hasMore, messages.length, loadOlderMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (!loadingMore && hasMore && el.scrollTop < 80) {
      loadOlderMessages();
    }
  }, [loadOlderMessages, loadingMore, hasMore]);

  const startPolling = useCallback(
    (taskId: string, conversationId: string, initialSeq?: number) => {
      if (pollRef.current) clearInterval(pollRef.current);
      lastSeqRef.current = initialSeq ?? 0;
      pollFailures.current = 0;
      setConnectionLost(false);

      pollRef.current = setInterval(async () => {
        try {
          const [task, tmsgs] = await Promise.all([
            getTask(taskId, workspaceId),
            getTaskMessages(taskId, workspaceId, lastSeqRef.current || undefined),
          ]);

          pollFailures.current = 0;
          setConnectionLost(false);
          setActiveTask(task);

          if (tmsgs.length > 0) {
            setTaskMessages((prev) => {
              const existingSeqs = new Set(prev.map((m) => m.seq));
              const unique = tmsgs.filter((m) => !existingSeqs.has(m.seq));
              return unique.length > 0 ? [...prev, ...unique] : prev;
            });
            lastSeqRef.current = Math.max(
              ...tmsgs.map((m) => m.seq),
              lastSeqRef.current
            );
          }

          if (task.status === "completed" || task.status === "failed") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;

            try {
              // Fetch latest messages and merge with any older pagination-loaded messages.
              // Keep taskMessages so the trace stays visible under the completed assistant reply.
              const latest = await listMessages(conversationId, workspaceId);
              setMessages((prev) => mergeMessages(prev, latest));
              requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: "instant",
                });
              });
            } catch {
              toast.error("Failed to refresh messages");
            }
            setActiveTask(task);
          }
        } catch {
          pollFailures.current += 1;
          if (pollFailures.current >= 3) {
            setConnectionLost(true);
          }
          if (pollFailures.current >= 10) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            toast.error("Lost connection to agent");
          }
        }
      }, 3000);
    },
    [workspaceId, scrollToBottom]
  );
  startPollingRef.current = startPolling;

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const activeTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeTaskIdRef.current = activeTask?.id ?? null;
  }, [activeTask]);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "task.messages" && msg.taskId === activeTaskIdRef.current) {
        const incoming = msg.messages.filter((m) => m.seq > lastSeqRef.current);
        if (incoming.length > 0) {
          setTaskMessages((prev) => {
            const existingSeqs = new Set(prev.map((m) => m.seq));
            const unique = incoming.filter((m) => !existingSeqs.has(m.seq));
            return unique.length > 0 ? [...prev, ...unique] : prev;
          });
          lastSeqRef.current = Math.max(...incoming.map((m) => m.seq), lastSeqRef.current);
        }
      }
      if (msg.type === "artifact.uploaded" && msg.conversationId === conversation?.id) {
        setArtifacts((prev) => {
          if (prev.some((a) => a.id === msg.artifact.id)) return prev;
          return [...prev, msg.artifact];
        });
      }
    });
  }, [subscribeWs, conversation?.id]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending || !conversation) return;

    setInput("");
    setSending(true);

    const optimistic: Message = {
      id: `temp-${Date.now()}`,
      conversation_id: conversation.id,
      role: "user",
      content,
      task_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    scrollToBottom();

    try {
      const { message, task } = await sendMessage(conversation.id, content, workspaceId);
      setMessages((prev) =>
        prev.map((m) => (m.id === optimistic.id ? message : m))
      );
      setActiveTask(task);
      setTaskMessages([]);
      startPolling(task.id, conversation.id);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setInput(content);
      toast.error(
        err instanceof Error ? err.message : "Failed to send message"
      );
    } finally {
      setSending(false);
    }
  };

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetDontAsk, setResetDontAsk] = useState(false);

  const RESET_SKIP_KEY = "chat-reset-skip-confirm";

  const executeReset = async () => {
    if (!conversation) return;
    setResetting(true);
    try {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      await deleteConversation(conversation.id, workspaceId);
      const newConv = await getOrCreateAgentConversation(agentId, workspaceId);
      setConversation(newConv);
      setMessages([]);
      setActiveTask(null);
      setTaskMessages([]);
      setArtifacts([]);
      lastSeqRef.current = 0;
      setConnectionLost(false);
      setHasMore(false);
      initialScrollDone.current = false;
    } catch {
      toast.error("Failed to reset conversation");
    } finally {
      setResetting(false);
      setResetConfirmOpen(false);
    }
  };

  const handleReset = () => {
    if (!conversation || messages.length === 0) return;
    const skip = typeof window !== "undefined" && localStorage.getItem(RESET_SKIP_KEY) === "true";
    if (skip) {
      executeReset();
    } else {
      setResetDontAsk(false);
      setResetConfirmOpen(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (loading) {
    return (
      <>
        <div className="flex-1 overflow-y-auto px-5">
          <div className="mx-auto max-w-2xl py-6 space-y-4">
            {/* Skeleton user message */}
            <div className="flex justify-end">
              <Skeleton className="h-10 w-48 rounded-lg" />
            </div>
            {/* Skeleton assistant message */}
            <div className="flex justify-start">
              <div className="space-y-2 px-1 py-1">
                <Skeleton className="h-4 w-72" />
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
            {/* Another pair */}
            <div className="flex justify-end">
              <Skeleton className="h-10 w-36 rounded-lg" />
            </div>
            <div className="flex justify-start">
              <div className="space-y-2 px-1 py-1">
                <Skeleton className="h-4 w-64" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>
          </div>
        </div>
        {/* Skeleton input area */}
        <div className="px-5 py-3">
          <div className="mx-auto max-w-2xl">
            <Skeleton className="h-[72px] w-full rounded-xl" />
          </div>
        </div>
      </>
    );
  }

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Failed to load conversation
      </div>
    );
  }

  return (
    <>
      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden px-5 thin-scrollbar"
        ref={scrollRef}
        onScroll={handleScroll}
        onClick={(e) => {
          const btn = (e.target as HTMLElement).closest(
            '[data-streamdown="code-block-actions"] button'
          );
          if (btn) toast.success("Copied to clipboard");
        }}
      >
        <div className="mx-auto max-w-2xl py-6 space-y-4">
          {/* Load more indicator */}
          {loadingMore && (
            <div className="flex justify-center py-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {messages.length === 0 && !activeTask && (
            <p className="text-center text-muted-foreground py-20 text-sm">
              Send a message to start chatting with the agent.
            </p>
          )}

          {timeline.map((item) => {
            if (item.kind === "artifact") {
              return (
                <ArtifactCard
                  key={`artifact-${item.data.id}`}
                  artifact={item.data}
                  onClick={handleArtifactClick}
                />
              );
            }

            const msg = item.data;
            const hasTaskStream =
              activeTask &&
              msg.role === "assistant" &&
              msg.task_id === activeTask.id &&
              taskMessages.length > 0;

            return (
              <React.Fragment key={msg.id}>
                {hasTaskStream && (
                  <TaskStream
                    task={activeTask}
                    messages={taskMessages}
                    connectionLost={connectionLost}
                  />
                )}
                {msg.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-lg px-4 py-2 bg-primary text-primary-foreground text-base whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                ) : !hasTaskStream ? (
                  <div className="flex justify-start">
                    <div className="markdown max-w-full min-w-0 px-1 py-1 text-base text-foreground">
                      <Streamdown controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: true } }} linkSafety={{ enabled: false }}>{msg.content}</Streamdown>
                    </div>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}

          {/* Show trace while task is in progress (no assistant message yet) */}
          {activeTask && activeTask.status !== "completed" && activeTask.status !== "failed" && (
            <TaskStream
              task={activeTask}
              messages={taskMessages}
              connectionLost={connectionLost}
            />
          )}
        </div>
      </div>

      {/* Input */}
      <div className="px-5 py-3">
        <div className="mx-auto max-w-2xl relative">
          <div
            className={cn(
              "relative flex flex-col rounded-xl border bg-background/60 transition-colors duration-200",
              "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
              (sending || (!!activeTask && activeTask.status !== "completed" && activeTask.status !== "failed")) && "opacity-50"
            )}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              disabled={sending || (!!activeTask && activeTask.status !== "completed" && activeTask.status !== "failed")}
              className={cn(
                "field-sizing-content w-full resize-none bg-transparent px-3.5 pt-2.5 text-base outline-none",
                "placeholder:text-muted-foreground disabled:cursor-not-allowed",
                "min-h-[38px] max-h-[200px] thin-scrollbar"
              )}
            />
            <div className="flex items-center justify-between px-2 pb-2 pt-0.5">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleReset}
                  disabled={resetting || !conversation || messages.length === 0}
                  className="rounded-lg text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                  title="New conversation"
                >
                  {resetting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setArtifactSheetOpen(true)}
                  className="relative rounded-lg text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                  title="View artifacts"
                >
                  <Box className="size-3.5" />
                  {artifacts.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground">
                      {artifacts.length}
                    </span>
                  )}
                </Button>
              </div>
              <Button
                size="icon-sm"
                onClick={handleSend}
                disabled={!input.trim() || sending || (!!activeTask && activeTask.status !== "completed" && activeTask.status !== "failed")}
                className={cn(
                  "rounded-lg transition-opacity duration-200",
                  !input.trim() && "opacity-40"
                )}
              >
                {sending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Start new conversation?</DialogTitle>
            <DialogDescription>
              This will clear the current conversation and start fresh. The agent won&apos;t remember context from this chat.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={resetDontAsk}
              onChange={(e) => setResetDontAsk(e.target.checked)}
              className="rounded"
            />
            Don&apos;t ask me next time
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetConfirmOpen(false)}
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (resetDontAsk) {
                  localStorage.setItem(RESET_SKIP_KEY, "true");
                }
                executeReset();
              }}
              disabled={resetting}
            >
              {resetting ? "Resetting..." : "Reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ArtifactSheet
        open={artifactSheetOpen}
        onOpenChange={(v) => {
          setArtifactSheetOpen(v);
          if (!v) setSelectedArtifact(null);
        }}
        artifacts={artifacts}
        workspaceId={workspaceId}
        initialArtifact={selectedArtifact}
      />
    </>
  );
}
