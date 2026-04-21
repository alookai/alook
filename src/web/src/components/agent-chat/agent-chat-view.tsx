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
  listBufferedMessages,
  createBufferedMessage,
  deleteBufferedMessage,
} from "@/lib/api";
import type { Artifact, Conversation, Message, TaskApi as Task, TaskMessage, WsMessage } from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUp, Box, FileText, Loader2, Mic, Paperclip, RotateCcw, X } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
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
import { FollowUpBuffer } from "@/components/agent-chat/follow-up-buffer";

const MESSAGE_LIMIT = 20;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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

function AttachmentChips({
  attachmentIds,
  artifacts,
  onArtifactClick,
}: {
  attachmentIds: string[];
  artifacts: Artifact[];
  onArtifactClick: (a: Artifact) => void;
}) {
  const matched = attachmentIds
    .map((id) => artifacts.find((a) => a.id === id))
    .filter((a): a is Artifact => !!a);

  if (matched.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {matched.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onArtifactClick(a); }}
          className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-0.5 text-xs text-primary-foreground/80 hover:bg-primary-foreground/20 transition-colors cursor-pointer"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate max-w-[150px]">{a.filename}</span>
        </button>
      ))}
    </div>
  );
}

function PendingFileChips({
  pendingFiles,
  messageId,
}: {
  pendingFiles: Map<string, File[]>;
  messageId: string;
}) {
  const files = pendingFiles.get(messageId);
  if (!files || files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {files.map((f, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/10 border border-primary-foreground/20 px-2 py-0.5 text-xs text-primary-foreground/80"
        >
          <FileText className="size-3 shrink-0" />
          <span className="truncate max-w-[150px]">{f.name}</span>
        </span>
      ))}
    </div>
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
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [bufferedMessages, setBufferedMessages] = useState<Message[]>([]);

  const pendingFilesMapRef = useRef<Map<string, File[]>>(new Map());

  const handleSpeechResult = useCallback((text: string) => {
    setInput((prev) => (prev ? prev + " " + text : text));
  }, []);
  const { listening, supported: speechSupported, toggle: toggleSpeech } = useSpeechRecognition(handleSpeechResult);

  const agentArtifacts = useMemo(() => artifacts.filter((a) => a.source === "agent"), [artifacts]);

  const timeline = useMemo(() => buildTimeline(messages, agentArtifacts), [messages, agentArtifacts]);

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
  const pollTaskIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const pollFailures = useRef(0);
  const initialScrollDone = useRef(false);
  const loadingMoreRef = useRef(false);
  const isNearBottom = useRef(true);
  const startPollingRef = useRef<(taskId: string, conversationId: string, initialSeq?: number) => void>(null!);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const key = `chat-draft:${agentId}`;
    if (input) {
      localStorage.setItem(key, input);
    } else {
      localStorage.removeItem(key);
    }
  }, [input, agentId]);

  useEffect(() => {
    if (!sending) {
      textareaRef.current?.focus();
    }
  }, [sending]);

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
        const [msgs, arts, buffered] = await Promise.allSettled([
          listMessages(conv.id, workspaceId, { limit: MESSAGE_LIMIT }),
          listArtifacts(conv.id, workspaceId),
          listBufferedMessages(conv.id, workspaceId),
        ]);

        if (msgs.status === "fulfilled") {
          setMessages(msgs.value);
          setHasMore(msgs.value.length >= MESSAGE_LIMIT);
        } else {
          toast.error("Failed to load messages");
        }
        if (arts.status === "fulfilled") {
          setArtifacts(arts.value);
        }
        if (buffered.status === "fulfilled") {
          setBufferedMessages(buffered.value);
        }

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
      pollTaskIdRef.current = taskId;

      pollRef.current = setInterval(async () => {
        // A new poll was started (e.g. by followup.dispatched) — bail out
        if (pollTaskIdRef.current !== taskId) return;

        try {
          const [task, tmsgs] = await Promise.all([
            getTask(taskId, workspaceId),
            getTaskMessages(taskId, workspaceId, lastSeqRef.current || undefined),
          ]);

          // Re-check after await — a followup.dispatched may have started a new poll
          const isStale = pollTaskIdRef.current !== taskId;

          pollFailures.current = 0;
          setConnectionLost(false);

          if (tmsgs.length > 0 && !isStale) {
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
            if (isStale) {
              // Stale poll — still merge messages but don't touch activeTask or polling
              listMessages(conversationId, workspaceId)
                .then((latest) => setMessages((prev) => mergeMessages(prev, latest)))
                .catch(() => {});
              return;
            }

            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;

            const shouldScroll = isNearBottom.current;
            try {
              const [latest, arts] = await Promise.all([
                listMessages(conversationId, workspaceId),
                listArtifacts(conversationId, workspaceId).catch(() => null),
              ]);
              setMessages((prev) => mergeMessages(prev, latest));
              if (arts) setArtifacts(arts);
              setActiveTask(task);
            } catch {
              setActiveTask(task);
              toast.error("Failed to refresh messages");
            }
            if (shouldScroll) {
              requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: "smooth",
                });
              });
            }
          } else if (!isStale) {
            setActiveTask(task);
          }
        } catch {
          if (pollTaskIdRef.current !== taskId) return;
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
    [workspaceId]
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
      if (msg.type === "followup.dispatched" && msg.conversationId === conversation?.id) {
        setBufferedMessages((prev) => prev.filter((m) => m.id !== msg.message.id));
        // Fetch all messages so the completed task's agent response is included
        listMessages(msg.conversationId, workspaceId)
          .then((latest) => setMessages((prev) => mergeMessages(prev, latest)))
          .catch(() => {});
        const task = msg.task as Task;
        setActiveTask(task);
        setTaskMessages([]);
        startPollingRef.current(task.id, msg.conversationId);
      }
      if (msg.type === "followup.created" && msg.conversationId === conversation?.id) {
        setBufferedMessages((prev) => {
          if (prev.some((m) => m.id === msg.message.id)) return prev;
          return [...prev, msg.message];
        });
      }
      if (msg.type === "followup.deleted" && msg.conversationId === conversation?.id) {
        setBufferedMessages((prev) => prev.filter((m) => m.id !== msg.messageId));
      }
      if (msg.type === "followup.dispatch_failed" && msg.conversationId === conversation?.id) {
        toast.error(msg.error || "Failed to dispatch follow-up");
      }
    });
  }, [subscribeWs, conversation?.id]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList) return;

    const valid: File[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds 10 MB limit`);
      } else {
        valid.push(file);
      }
    }
    if (valid.length > 0) {
      setPendingFiles((prev) => [...prev, ...valid]);
    }
    // Reset input so re-selecting the same file works
    e.target.value = "";
  }, []);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;

    const droppedFiles = Array.from(e.dataTransfer.files);
    const valid: File[] = [];
    for (const file of droppedFiles) {
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds 10 MB limit`);
      } else {
        valid.push(file);
      }
    }
    if (valid.length > 0) {
      setPendingFiles((prev) => [...prev, ...valid]);
    }
  }, []);

  const handleSend = async () => {
    const content = input.trim();
    if ((!content && pendingFiles.length === 0) || sending || !conversation) return;
    if (!content) {
      toast.error("Please type a message");
      return;
    }

    const filesToSend = [...pendingFiles];
    setInput("");
    setPendingFiles([]);
    setSending(true);

    const taskActive = !!activeTask && activeTask.status !== "completed" && activeTask.status !== "failed";

    if (taskActive) {
      // Buffer mode: queue message for later dispatch
      const optimisticId = `temp-${Date.now()}`;
      const optimistic: Message = {
        id: optimisticId,
        conversation_id: conversation.id,
        role: "user",
        content,
        task_id: null,
        attachment_ids: null,
        status: "buffered",
        created_at: new Date().toISOString(),
      };
      setBufferedMessages((prev) => [...prev, optimistic]);

      try {
        const { message } = await createBufferedMessage(
          conversation.id,
          content,
          workspaceId,
          filesToSend.length > 0 ? filesToSend : undefined,
        );
        setBufferedMessages((prev) =>
          prev.map((m) => (m.id === optimisticId ? message : m))
        );
      } catch (err) {
        setBufferedMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setInput(content);
        setPendingFiles(filesToSend);
        toast.error(
          err instanceof Error ? err.message : "Failed to queue follow-up"
        );
      } finally {
        setSending(false);
      }
      return;
    }

    // Normal mode: send message and enqueue task
    const optimisticId = `temp-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      conversation_id: conversation.id,
      role: "user",
      content,
      task_id: null,
      attachment_ids: null,
      created_at: new Date().toISOString(),
    };

    // Store pending files for the optimistic message rendering
    if (filesToSend.length > 0) {
      pendingFilesMapRef.current.set(optimisticId, filesToSend);
    }

    setMessages((prev) => [...prev, optimistic]);
    scrollToBottom();

    try {
      const { message, task } = await sendMessage(
        conversation.id,
        content,
        workspaceId,
        filesToSend.length > 0 ? filesToSend : undefined,
      );
      // Clean up pending files ref
      pendingFilesMapRef.current.delete(optimisticId);
      setMessages((prev) =>
        prev.map((m) => (m.id === optimistic.id ? message : m))
      );
      if (message.attachment_ids && message.attachment_ids.length > 0) {
        listArtifacts(conversation.id, workspaceId)
          .then((arts) => setArtifacts(arts))
          .catch(() => {});
      }
      setActiveTask(task);
      setTaskMessages([]);
      startPolling(task.id, conversation.id);
    } catch (err) {
      pendingFilesMapRef.current.delete(optimisticId);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setInput(content);
      setPendingFiles(filesToSend);
      toast.error(
        err instanceof Error ? err.message : "Failed to send message"
      );
    } finally {
      setSending(false);
      textareaRef.current?.focus();
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
      setBufferedMessages([]);
      setPendingFiles([]);
      pendingFilesMapRef.current.clear();
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

  const isTaskActive = !!activeTask && activeTask.status !== "completed" && activeTask.status !== "failed";

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
                      {msg.attachment_ids && msg.attachment_ids.length > 0 && (
                        <AttachmentChips attachmentIds={msg.attachment_ids} artifacts={artifacts} onArtifactClick={handleArtifactClick} />
                      )}
                      {!msg.attachment_ids && (
                        <PendingFileChips pendingFiles={pendingFilesMapRef.current} messageId={msg.id} />
                      )}
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

      {/* Follow-up buffer indicator */}
      <FollowUpBuffer
        bufferedMessages={bufferedMessages}
        onDelete={(messageId) => {
          const prev = bufferedMessages;
          setBufferedMessages((cur) => cur.filter((m) => m.id !== messageId));
          deleteBufferedMessage(conversation.id, messageId, workspaceId).catch(() => {
            setBufferedMessages(prev);
            toast.error("Failed to delete follow-up");
          });
        }}
      />

      {/* Input */}
      <div className="px-5 py-3">
        <div className="mx-auto max-w-2xl relative">
          <div
            className={cn(
              "relative flex flex-col rounded-xl border bg-background/60 transition-colors duration-200",
              "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
              sending && "opacity-50",
              dragging && "border-ring ring-3 ring-ring/50"
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {dragging && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/80 border-2 border-dashed border-ring pointer-events-none">
                <p className="text-sm text-muted-foreground font-medium">Drop files here</p>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isTaskActive ? "Type a follow-up..." : "Type a message..."}
              rows={1}
              disabled={sending}
              className={cn(
                "field-sizing-content w-full resize-none bg-transparent px-3.5 pt-2.5 text-base outline-none",
                "placeholder:text-muted-foreground disabled:cursor-not-allowed",
                "min-h-[38px] max-h-[200px] thin-scrollbar"
              )}
            />

            {/* Pending file pills */}
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3.5 pb-1">
                {pendingFiles.map((file, i) => (
                  <span
                    key={`${file.name}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate max-w-[120px]">{file.name}</span>
                    <span className="text-muted-foreground/60">{formatSize(file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removePendingFile(i)}
                      className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20 transition-colors"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

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
                  {agentArtifacts.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground">
                      {agentArtifacts.length}
                    </span>
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                  className="rounded-lg text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                  title="Attach files"
                >
                  <Paperclip className="size-3.5" />
                </Button>
                {speechSupported && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleSpeech}
                    disabled={sending}
                    className={cn(
                      "rounded-lg transition-colors duration-200",
                      listening
                        ? "text-red-500 hover:text-red-600 bg-red-500/10"
                        : "text-muted-foreground/60 hover:text-foreground"
                    )}
                    title={listening ? "Stop recording" : "Voice input"}
                  >
                    <Mic className={cn("size-3.5", listening && "animate-pulse")} />
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  onClick={handleSend}
                  disabled={!input.trim() || sending}
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
          if (!v) setTimeout(() => setSelectedArtifact(null), 300);
        }}
        artifacts={agentArtifacts}
        workspaceId={workspaceId}
        initialArtifact={selectedArtifact}
      />
    </>
  );
}
