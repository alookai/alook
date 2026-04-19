"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
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
} from "@/lib/api";
import type { Conversation, Message, TaskApi as Task, TaskMessage } from "@alook/shared";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUp, Loader2 } from "lucide-react";
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

export function AgentChatView() {
  const params = useParams();
  const { workspaceId } = useWorkspace();
  const agentId = params.id as string;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeqRef = useRef(0);
  const pollFailures = useRef(0);
  const initialScrollDone = useRef(false);
  const loadingMoreRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 50);
  }, []);

  // Resolve conversation (get or create) then load messages
  useEffect(() => {
    async function load() {
      try {
        const conv = await getOrCreateAgentConversation(agentId, workspaceId);
        setConversation(conv);
        const msgs = await listMessages(conv.id, workspaceId, { limit: MESSAGE_LIMIT });
        setMessages(msgs);
        setHasMore(msgs.length >= MESSAGE_LIMIT);
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

  // Detect scroll to top for loading more
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasMore) return;
    if (el.scrollTop < 80) {
      loadOlderMessages();
    }
  }, [loadOlderMessages, loadingMore, hasMore]);

  const startPolling = useCallback(
    (taskId: string, conversationId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      lastSeqRef.current = 0;
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
            setTaskMessages((prev) => [...prev, ...tmsgs]);
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
              scrollToBottom();
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
      }, 1000);
    },
    [workspaceId, scrollToBottom]
  );

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

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
        className="flex-1 overflow-y-auto px-5 thin-scrollbar"
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

          {messages.map((msg) => {
            const hasTaskStream =
              activeTask &&
              msg.role === "assistant" &&
              msg.task_id === activeTask.id &&
              taskMessages.length > 0;

            return (
              <React.Fragment key={msg.id}>
                {/* Show full trace (including text) for completed tasks */}
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
                    <div className="markdown max-w-full px-1 py-1 text-base text-foreground">
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
        <div className="mx-auto max-w-2xl">
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
                "min-h-[38px] max-h-[200px]"
              )}
            />
            <div className="flex items-center justify-end px-2 pb-2 pt-0.5">
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
    </>
  );
}
