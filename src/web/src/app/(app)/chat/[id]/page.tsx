"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AgentEditForm } from "@/components/agent-edit-form";
import {
  getConversation,
  listMessages,
  sendMessage,
  getTask,
  getTaskMessages,
} from "@/lib/api";
import type { Conversation, Message, TaskMessage } from "@alook/shared";
import type { Task } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ArrowUp, Loader2, Pencil, Trash2, X } from "lucide-react";
import { Streamdown } from "streamdown";

export default function ChatPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const conversationId = params.id as string;
  const { agents, runtimes, handleDeleteAgent, handleUpdateAgent } =
    useAgentContext();

  const agentId = searchParams.get("agent");
  const agent = agents.find((a) => a.id === agentId);

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);

  // Inline edit state
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSeqRef = useRef(0);
  const pollFailures = useRef(0);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 50);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const [conv, msgs] = await Promise.all([
          getConversation(conversationId),
          listMessages(conversationId),
        ]);
        setConversation(conv);
        setMessages(msgs);
      } catch {
        toast.error("Conversation not found");
        router.push("/home");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [conversationId, router]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, taskMessages, scrollToBottom]);

  const startPolling = useCallback(
    (taskId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      lastSeqRef.current = 0;
      pollFailures.current = 0;
      setConnectionLost(false);

      pollRef.current = setInterval(async () => {
        try {
          const [task, tmsgs] = await Promise.all([
            getTask(taskId),
            getTaskMessages(taskId, lastSeqRef.current || undefined),
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
              const updatedMessages = await listMessages(conversationId);
              setMessages(updatedMessages);
            } catch {
              toast.error("Failed to refresh messages");
            }
            setActiveTask(null);
            setTaskMessages([]);
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
    [conversationId]
  );

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending) return;

    setInput("");
    setSending(true);

    const optimistic: Message = {
      id: `temp-${Date.now()}`,
      conversation_id: conversationId,
      role: "user",
      content,
      task_id: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const { message, task } = await sendMessage(conversationId, content);
      setMessages((prev) =>
        prev.map((m) => (m.id === optimistic.id ? message : m))
      );
      setActiveTask(task);
      setTaskMessages([]);
      startPolling(task.id);
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
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      {/* Agent navbar — stable regardless of edit/chat view */}
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {agent && (() => {
            const runtime = runtimes.find((r) => r.id === agent.runtime_id);
            const isOnline = runtime?.status === "online";
            return (
              <span
                title={isOnline ? "Runtime online" : "Runtime offline"}
                className={cn(
                  "size-2 rounded-full shrink-0",
                  isOnline ? "bg-status-online" : "bg-status-offline"
                )}
              />
            );
          })()}
          <h1
            className={cn(
              "text-sm font-medium truncate",
              agentId && "cursor-pointer hover:opacity-70 transition-opacity duration-200"
            )}
            onClick={() => agentId && router.push(`/agents/${agentId}`)}
          >
            {agent?.name || "Agent"}
          </h1>
          {!editing && conversation?.title && (
            <span className="text-xs text-muted-foreground truncate">
              / {conversation.title}
            </span>
          )}
          {editing && (
            <span className="text-xs text-muted-foreground">/ Settings</span>
          )}
        </div>
        {agent && (
          <div className="flex items-center gap-0.5 shrink-0">
            {editing ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground h-7 gap-1 px-2"
                onClick={() => setEditing(false)}
              >
                <X className="size-3" />
                Cancel
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground h-7 gap-1 px-2"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-3" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground h-7 px-2 hover:text-destructive"
                  onClick={() => setConfirmOpen(true)}
                >
                  <Trash2 className="size-3" />
                  Remove
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {editing && agent ? (
        <AgentEditForm
          agent={agent}
          runtimes={runtimes}
          saving={saving}
          onCancel={() => setEditing(false)}
          onSave={async (data) => {
            setSaving(true);
            try {
              const ok = await handleUpdateAgent(agent.id, data);
              if (ok) setEditing(false);
              return ok;
            } finally {
              setSaving(false);
            }
          }}
        />
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5" ref={scrollRef}>
            <div className="mx-auto max-w-2xl py-6 space-y-4">
              {messages.length === 0 && !activeTask && (
                <p className="text-center text-muted-foreground py-20 text-sm">
                  Send a message to start chatting with the agent.
                </p>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {msg.role === "user" ? (
                    <div className="max-w-[80%] rounded-lg px-4 py-2 bg-primary text-primary-foreground whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="markdown max-w-full px-1 py-1 text-base text-foreground">
                      <Streamdown>{msg.content}</Streamdown>
                    </div>
                  )}
                </div>
              ))}

              {activeTask && (
                <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      {activeTask.status === "running"
                        ? "Agent working..."
                        : activeTask.status}
                    </Badge>
                  </div>
                  {taskMessages.length > 0 && (
                    <div className="mt-2 max-h-60 overflow-y-auto rounded-lg bg-muted/30 p-3 font-mono text-xs space-y-1">
                      {taskMessages.map((tm) => (
                        <div key={tm.id} className="text-muted-foreground">
                          {tm.type === "tool-use" && (
                            <span className="text-primary">
                              [tool] {tm.tool}
                            </span>
                          )}
                          {tm.type === "tool-result" && (
                            <span className="text-accent-foreground">
                              [result] {tm.output || tm.content}
                            </span>
                          )}
                          {tm.type === "text" && <span>{tm.content}</span>}
                          {tm.type === "thinking" && (
                            <span className="italic opacity-60">
                              {tm.content}
                            </span>
                          )}
                          {!["tool-use", "tool-result", "text", "thinking"].includes(
                            tm.type
                          ) && (
                            <span>
                              [{tm.type}] {tm.content}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {activeTask.status === "failed" && activeTask.error && (
                    <p className="text-sm text-destructive">
                      {activeTask.error}
                    </p>
                  )}
                  {connectionLost && (
                    <p className="text-xs text-muted-foreground animate-pulse">
                      Connection lost — retrying...
                    </p>
                  )}
                </div>
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
                  (sending || !!activeTask) && "opacity-50"
                )}
              >
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  rows={1}
                  disabled={sending || !!activeTask}
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
                    disabled={!input.trim() || sending || !!activeTask}
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
      )}

      {agent && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Remove agent"
          description={`This will permanently delete "${agent.name}" and all its conversations.`}
          loading={deleting}
          onConfirm={async () => {
            setDeleting(true);
            try {
              const ok = await handleDeleteAgent(agent.id);
              if (ok) router.push("/home");
            } finally {
              setDeleting(false);
              setConfirmOpen(false);
            }
          }}
        />
      )}
    </>
  );
}
