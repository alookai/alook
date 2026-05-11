"use client";

import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import { useParams, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { TaskStream } from "@/components/task-stream";
import {
  chatInit,
  createConversation,
  getConversation,
  listMessages,
  listMessagesAroundTask,
  listPreviousConversations,
  sendMessage,
  getTask,
  getTaskMessages,
  getTaskStepCounts,
  listArtifacts,
  listBufferedMessages,
  createBufferedMessage,
  deleteBufferedMessage,
  cancelActiveTask,
  getActiveTask,
  retryTask,
  markInboxRead,
  getIssue,
  getTrace,
  updateIssue,
} from "@/lib/api";
import type { PreviousConversation, TraceTask } from "@/lib/api";
import type { Artifact, Conversation, Issue, IssueComment, Message, TaskApi as Task, TaskMessage, WsMessage } from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { useInboxCount } from "@/contexts/inbox-count-context";
import { useChannel } from "@/contexts/channel-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ArrowUp, BedDouble, Box, FileText, Loader2, Mail, MessageSquareQuote, Mic, Paperclip, Square, X } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useMentionPopup } from "@/hooks/use-mention-popup";
import { MentionPopup } from "@/components/agent-chat/mention-popup";
import { highlightMentions } from "@/lib/highlight-mentions";
import { ArtifactSheet, formatSize } from "@/components/agent-chat/artifact-sheet";
import { EmailEventSheet } from "@/components/agent-chat/email-event-sheet";
import { IssueSheet } from "@/components/issues/issue-sheet";
import { isPreviewable, getArtifactUrl } from "@/components/artifact-content-renderer";
import { FollowUpBuffer } from "@/components/agent-chat/follow-up-buffer";
import { ScrollToBottomButton } from "@/components/ui/scroll-to-bottom-button";
import { MessageItem } from "@/components/agent-chat/message-list";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

const MESSAGE_LIMIT = 20;
const MAX_CONV_FETCHES_PER_CLICK = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function MentionHighlight(props: Record<string, unknown> & { children?: React.ReactNode }) {
  const { children, ...rest } = props;
  const { agents } = useAgentContext();
  const agentId = (rest["data-agent-id"] ?? rest.dataAgentId) as string | undefined;
  let agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  if (!agent && typeof children === "string") {
    const nameToMatch = children.startsWith("@") ? children.slice(1) : children;
    agent = agents.find((a) => a.name.toLowerCase() === nameToMatch.toLowerCase());
  }
  if (agent) {
    return (
      <Popover>
        <PopoverTrigger openOnHover delay={300} nativeButton={false} render={<span className="mention-highlight cursor-pointer" />}>
          {children}
        </PopoverTrigger>
        <PopoverContent side="top" className="w-fit max-w-80">
          <AgentPreviewCard agent={agent} />
        </PopoverContent>
      </Popover>
    );
  }
  return <span className="mention-highlight">{children}</span>;
}
const MENTION_COMPONENTS: Record<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>> = {
  mention: MentionHighlight,
  p: ({ children, node, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => {
    void node;
    return <div data-md-p="" {...rest}>{children}</div>;
  },
};

type EventIconType = "issue" | "email" | "calendar";

export function getEventIconType(content: string, conversationType?: string | null): EventIconType {
  if (conversationType === "issue_event") return "issue";
  if (conversationType === "email_notification") return "email";
  if (conversationType === "calendar_event") return "calendar";

  const lower = content.toLowerCase();
  if (lower.startsWith("issue ") || lower.startsWith("issue:")) return "issue";
  if (lower.includes("email")) return "email";
  return "calendar";
}


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

export function addBufferedIfNew(prev: Message[], incoming: Message): Message[] {
  if (prev.some((m) => m.id === incoming.id)) return prev;
  // Skip if there's a recent optimistic entry — avoids brief duplicate flash
  // when WS followup.created arrives before createBufferedMessage HTTP response.
  const t = new Date(incoming.created_at).getTime();
  if (prev.some((m) => m.id.startsWith("temp-") && Math.abs(new Date(m.created_at).getTime() - t) < 2000)) {
    return prev;
  }
  return [...prev, incoming];
}

export function replaceOptimisticBuffered(prev: Message[], optimisticId: string, real: Message): Message[] {
  if (prev.some((m) => m.id === real.id)) {
    return prev.filter((m) => m.id !== optimisticId);
  }
  return prev.map((m) => (m.id === optimisticId ? real : m));
}

export type NapMarker = { agentName: string; created_at: string; id: string };

type TimelineItem =
  | { kind: "message"; data: Message }
  | { kind: "artifact"; data: Artifact }
  | { kind: "nap"; data: NapMarker };

export function reorderArtifactsAfterAssistant(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  let pending: TimelineItem[] = [];
  let collecting = false;

  for (const item of items) {
    if (item.kind === "message" && item.data.role === "user") {
      collecting = true;
      result.push(item);
    } else if (item.kind === "message" && item.data.role === "assistant") {
      result.push(item);
      result.push(...pending);
      pending = [];
      collecting = false;
    } else if (collecting && item.kind === "artifact") {
      pending.push(item);
    } else {
      result.push(item);
    }
  }

  result.push(...pending);
  return result;
}

export function buildTimeline(
  messages: Message[],
  artifacts: Artifact[],
  napMarkers: NapMarker[],
  currentConversationId?: string | null,
): TimelineItem[] {
  if (!currentConversationId || napMarkers.length === 0) {
    const items: TimelineItem[] = [
      ...messages.map((m): TimelineItem => ({ kind: "message", data: m })),
      ...artifacts.map((a): TimelineItem => ({ kind: "artifact", data: a })),
      ...napMarkers.map((n): TimelineItem => ({ kind: "nap", data: n })),
    ];
    items.sort((a, b) => {
      const cmp = a.data.created_at.localeCompare(b.data.created_at);
      if (cmp !== 0) return cmp;
      if (a.kind === "nap" || b.kind === "nap") {
        if (a.kind === "nap" && b.kind !== "nap") return 1;
        if (a.kind !== "nap" && b.kind === "nap") return -1;
      }
      if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
      return a.data.id.localeCompare(b.data.id);
    });
    return reorderArtifactsAfterAssistant(items);
  }

  const napConvIds = new Set(napMarkers.map((n) => n.id.replace(/^nap-/, "")));
  const sortedNaps = [...napMarkers].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const groupItems = (convId: string): TimelineItem[] => {
    const msgs: TimelineItem[] = messages
      .filter((m) => m.conversation_id === convId)
      .map((m) => ({ kind: "message" as const, data: m }));
    const arts: TimelineItem[] = artifacts
      .filter((a) => a.conversation_id === convId)
      .map((a) => ({ kind: "artifact" as const, data: a }));
    const sorted = [...msgs, ...arts].sort((a, b) => {
      const cmp = a.data.created_at.localeCompare(b.data.created_at);
      if (cmp !== 0) return cmp;
      if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
      return a.data.id.localeCompare(b.data.id);
    });
    return reorderArtifactsAfterAssistant(sorted);
  };

  const result: TimelineItem[] = [];

  for (const nap of sortedNaps) {
    const convId = nap.id.replace(/^nap-/, "");
    result.push(...groupItems(convId));
    result.push({ kind: "nap", data: nap });
  }

  result.push(...groupItems(currentConversationId));

  const knownConvIds = new Set([...napConvIds, currentConversationId]);
  const orphanMsgs = messages.filter((m) => !knownConvIds.has(m.conversation_id));
  const orphanArts = artifacts.filter((a) => !knownConvIds.has(a.conversation_id));
  if (orphanMsgs.length > 0 || orphanArts.length > 0) {
    const orphanItems: TimelineItem[] = [
      ...orphanMsgs.map((m): TimelineItem => ({ kind: "message", data: m })),
      ...orphanArts.map((a): TimelineItem => ({ kind: "artifact", data: a })),
    ];
    orphanItems.sort((a, b) => {
      const cmp = a.data.created_at.localeCompare(b.data.created_at);
      if (cmp !== 0) return cmp;
      if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
      return a.data.id.localeCompare(b.data.id);
    });
    const reorderedOrphans = reorderArtifactsAfterAssistant(orphanItems);
    const napIdx = result.findIndex((item) => item.kind === "nap");
    if (napIdx >= 0) {
      result.splice(napIdx, 0, ...reorderedOrphans);
    } else {
      result.push(...reorderedOrphans);
    }
  }

  return result;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

function NapSeparator({ agentName }: { agentName: string }) {
  return (
    <div className="flex items-center gap-3 py-4 select-none" aria-hidden>
      <div className="flex-1 border-t border-border/40" />
      <span className="text-xs text-muted-foreground/60 whitespace-nowrap">
        {agentName} took a nap 💤
      </span>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}

function ArtifactCard({ artifact, version, hasDuplicates, onClick }: { artifact: Artifact; version: number; hasDuplicates: boolean; onClick: (a: Artifact) => void }) {
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
        <p className="text-sm font-medium truncate">
          {artifact.filename}
          {hasDuplicates && (
            <span className="ml-1.5 text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 font-normal">
              v{version}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{formatSize(artifact.size)}</p>
      </div>
    </button>
  );
}

export function AgentChatView() {
  const params = useParams();
  const searchParams = useSearchParams();
  const { workspaceId, slug } = useWorkspace();
  const { agents, agentLinks, activeTaskCounts, subscribeWs } = useAgentContext();
  const { refresh: refreshInboxCount } = useInboxCount();
  const { activeChannel, loading: channelLoading } = useChannel();
  const agentId = params.id as string;
  const scrollToTaskId = searchParams.get("task");
  const targetConvId = searchParams.get("conv");

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(`chat-draft:${agentId}:${targetConvId ?? 'default'}`) ?? "";
  });
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactSheetOpen, setArtifactSheetOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [emailSheetOpen, setEmailSheetOpen] = useState(false);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [issueSheetOpen, setIssueSheetOpen] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [issueDetail, setIssueDetail] = useState<{
    issue: Issue & { trace_id?: string | null };
    messages: Message[];
    comments: IssueComment[];
    artifacts: Artifact[];
  } | null>(null);
  const [issueDetailLoading, setIssueDetailLoading] = useState(false);
  const [issueTraceTasks, setIssueTraceTasks] = useState<TraceTask[] | null>(null);
  const [issueActiveTask, setIssueActiveTask] = useState<Task | null>(null);
  const [issueSidecarWidth, setIssueSidecarWidth] = useState(448);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [bufferedMessages, setBufferedMessages] = useState<Message[]>([]);
  const [caretIndex, setCaretIndex] = useState<number | null>(null);
  const [previousConversations, setPreviousConversations] = useState<PreviousConversation[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [napMarkers, setNapMarkers] = useState<NapMarker[]>([]);
  const [stepCounts, setStepCounts] = useState<Record<string, number>>({});
  const [renderNow] = useState(() => Date.now());

  const [pendingFilesByMessage, setPendingFilesByMessage] = useState<Map<string, File[]>>(() => new Map());
  const [quotedText, setQuotedText] = useState<string | null>(null);
  const [selectionPopup, setSelectionPopup] = useState<{ text: string; x: number; y: number } | null>(null);

  const handleSpeechResult = useCallback((text: string) => {
    setInput((prev) => (prev ? prev + " " + text : text));
  }, []);
  const { listening, supported: speechSupported, toggle: toggleSpeech } = useSpeechRecognition(handleSpeechResult);

  const agentArtifacts = useMemo(() => artifacts.filter((a) => a.source === "agent"), [artifacts]);

  const { versionMap, duplicateFilenames } = useMemo(() => {
    const groups = new Map<string, Artifact[]>();
    for (const a of agentArtifacts) {
      const group = groups.get(a.filename) || [];
      group.push(a);
      groups.set(a.filename, group);
    }
    const vm = new Map<string, number>();
    const dupes = new Set<string>();
    for (const [filename, group] of groups) {
      group.sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (group.length > 1) dupes.add(filename);
      group.forEach((a, i) => vm.set(a.id, i + 1));
    }
    return { versionMap: vm, duplicateFilenames: dupes };
  }, [agentArtifacts]);

  const timeline = useMemo(() => buildTimeline(messages, agentArtifacts, napMarkers, conversation?.id), [messages, agentArtifacts, napMarkers, conversation?.id]);

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
  const startPollingRef = useRef<((taskId: string, conversationId: string, initialSeq?: number) => void) | null>(null);
  const oldestConversationCursorRef = useRef<PreviousConversation | null>(null);
  const backfillAttemptsRef = useRef(0);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const otherAgents = useMemo(() => agents.filter(a => a.id !== agentId), [agents, agentId]);

  const mentionPopup = useMentionPopup({
    input,
    caretIndex,
    textareaRef,
    agents: otherAgents,
    agentLinks,
    currentAgentId: agentId,
    onInputChange: setInput,
  });

  useEffect(() => {
    const key = `chat-draft:${agentId}:${targetConvId ?? 'default'}`;
    if (input) {
      localStorage.setItem(key, input);
    } else {
      localStorage.removeItem(key);
    }
  }, [input, agentId, targetConvId]);

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

  useEffect(() => {
    if (channelLoading) return;

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    pollTaskIdRef.current = null;
    let ignore = false;
    queueMicrotask(() => {
      if (ignore) return;
      setLoading(true);
      initialScrollDone.current = false;
      setActiveTask(null);
      setTaskMessages([]);
      setBufferedMessages([]);
      setPendingFilesByMessage(new Map());
      setNapMarkers([]);
      setStepCounts({});
      setPreviousConversations([]);
      setHasMoreConversations(false);
      oldestConversationCursorRef.current = null;
      setInput(localStorage.getItem(`chat-draft:${agentId}:${targetConvId ?? 'default'}`) ?? "");
    });
    async function load() {
      try {
        if (targetConvId) {
          try {
            const [conv, msgsResult, arts, buffered] = await Promise.all([
              getConversation(targetConvId, workspaceId),
              listMessages(targetConvId, workspaceId),
              listArtifacts(targetConvId, workspaceId).catch(() => [] as Artifact[]),
              listBufferedMessages(targetConvId, workspaceId).catch(() => [] as Message[]),
            ]);
            if (ignore) return;
            setConversation(conv);
            setMessages(msgsResult.messages);
            setHasMore(msgsResult.has_more);
            setArtifacts(arts);
            setBufferedMessages(buffered);
            const taskIds = [...new Set(msgsResult.messages.filter((m) => m.role === "assistant" && m.task_id).map((m) => m.task_id!))];
            if (taskIds.length > 0) {
              getTaskStepCounts(taskIds, workspaceId)
                .then((counts) => { if (!ignore) setStepCounts(counts); })
                .catch(() => {});
            }
            if (scrollToTaskId) {
              const task = await getTask(scrollToTaskId, workspaceId).catch(() => null);
              if (ignore) return;
              if (task && !["completed", "failed", "cancelled", "superseded"].includes(task.status)) {
                setActiveTask(task);
                const tmsgs = await getTaskMessages(scrollToTaskId, workspaceId).catch(() => [] as TaskMessage[]);
                if (ignore) return;
                setTaskMessages(tmsgs);
                if (tmsgs.length > 0) {
                  lastSeqRef.current = Math.max(...tmsgs.map((m) => m.seq));
                }
                startPollingRef.current?.(task.id, targetConvId, lastSeqRef.current);
              }
            }
          } catch {
            const data = await chatInit(agentId, workspaceId, activeChannel);
            if (ignore) return;
            setConversation(data.conversation);
            setMessages(data.messages);
            setHasMore(data.has_more_messages);
            setArtifacts(data.artifacts);
            setBufferedMessages(data.buffered_messages);
            setHasMoreConversations(data.has_more_conversations);
          }
        } else {
          const data = await chatInit(agentId, workspaceId, activeChannel);
          if (ignore) return;
          setConversation(data.conversation);
          setMessages(data.messages);
          setHasMore(data.has_more_messages);
          setArtifacts(data.artifacts);
          setBufferedMessages(data.buffered_messages);
          setHasMoreConversations(data.has_more_conversations);

          if (data.active_task) {
            setActiveTask(data.active_task);
            if (data.task_messages.length > 0) {
              setTaskMessages(data.task_messages);
              lastSeqRef.current = Math.max(...data.task_messages.map((m) => m.seq));
            }
            if (!["completed", "failed", "cancelled", "superseded"].includes(data.active_task.status)) {
              startPollingRef.current?.(data.active_task.id, data.conversation.id, lastSeqRef.current);
            }
          }
        }
      } catch {
        toast.error("Failed to load conversation");
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    load();
    return () => { ignore = true; };
  }, [agentId, workspaceId, targetConvId, scrollToTaskId, activeChannel, channelLoading]);

  const markedReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversation?.id || !workspaceId) return;
    if (markedReadRef.current === conversation.id) return;
    markedReadRef.current = conversation.id;
    markInboxRead(conversation.id, workspaceId)
      .then(() => refreshInboxCount())
      .catch(() => {});
  }, [conversation?.id, workspaceId, refreshInboxCount]);

  // Scroll to bottom on initial load (skip if scroll-to-task is active)
  useEffect(() => {
    if (!loading && messages.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true;
      if (!scrollToTaskId) {
        setTimeout(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        }, 50);
      }
    }
  }, [loading, messages.length, scrollToTaskId]);

  // Scroll to task when ?task= param is present
  useEffect(() => {
    if (!scrollToTaskId || loading || !conversation) return;
    const tryScroll = () => {
      const el = document.querySelector(`[data-task-id="${CSS.escape(scrollToTaskId)}"]`);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("task-highlight");
      setTimeout(() => el.classList.remove("task-highlight"), 1500);
      return true;
    };
    setTimeout(async () => {
      if (tryScroll()) return;
      try {
        const around = await listMessagesAroundTask(conversation.id, workspaceId, scrollToTaskId);
        if (around.length > 0) {
          setMessages((prev) => mergeMessages(prev, around));
          requestAnimationFrame(() => {
            setTimeout(() => tryScroll(), 100);
          });
        }
      } catch { }
    }, 100);
  }, [scrollToTaskId, loading, conversation, workspaceId]);

  // Auto-scroll when task badge appears or new task steps arrive
  const taskStatus = activeTask?.status;
  useEffect(() => {
    const isRunning = taskStatus === "running" || taskStatus === "queued";
    if (isRunning && isNearBottom.current) {
      scrollToBottom();
    }
  }, [taskMessages.length, taskStatus, scrollToBottom]);

  const agentName = useMemo(() => agents.find((a) => a.id === agentId)?.name ?? "Agent", [agents, agentId]);

  const messagesRef = useLatest(messages);
  const hasMoreRef = useLatest(hasMore);
  const prevConvsRef = useLatest(previousConversations);
  const hasMoreConvsRef = useLatest(hasMoreConversations);
  const agentNameRef = useLatest(agentName);
  const activeChannelRef = useLatest(activeChannel);

  const loadOlderMessages = useCallback(async (scrollToEnd = false) => {
    if (!conversation || loadingMoreRef.current) return;
    loadingMoreRef.current = true;

    const currentMessages = messagesRef.current;
    const currentHasMore = hasMoreRef.current;
    const currentHasMoreConvs = hasMoreConvsRef.current;
    const currentAgentName = agentNameRef.current;
    const currentChannel = activeChannelRef.current;

    const oldest = currentMessages[0];
    const paginatingConvId = oldestConversationCursorRef.current?.id ?? conversation.id;
    const canLoadMoreInConv = currentHasMore && oldest;
    let prevConvsList = prevConvsRef.current;

    if (!canLoadMoreInConv && prevConvsList.length === 0 && currentHasMoreConvs) {
      const oldestConv = oldestConversationCursorRef.current ?? { id: conversation.id, created_at: conversation.created_at };
      try {
        const result = await listPreviousConversations(agentId, workspaceId, {
          exclude: conversation.id,
          before: oldestConv.created_at,
          channel: currentChannel,
        });
        prevConvsList = result.conversations;
        setPreviousConversations(result.conversations);
        setHasMoreConversations(result.has_more);
      } catch {
        setHasMoreConversations(false);
      }
    }

    const canLoadPrevConv = prevConvsList.length > 0;

    if (!canLoadMoreInConv && !canLoadPrevConv) {
      loadingMoreRef.current = false;
      return;
    }

    setLoadingMore(true);
    const el = scrollRef.current;
    if (el) el.style.overflowAnchor = "none";
    const prevScrollHeight = el?.scrollHeight ?? 0;

    try {
      let phase1Messages: Message[] = [];
      let phase2Messages: Message[] = [];
      let remaining = MESSAGE_LIMIT;
      let lastHasMore = false;
      const napMarkersToAdd: { agentName: string; created_at: string; id: string }[] = [];

      // --- Phase 1: Load from current/paginating conversation ---
      if (canLoadMoreInConv) {
        const result = await listMessages(paginatingConvId, workspaceId, {
          limit: MESSAGE_LIMIT,
          before: oldest!.created_at,
          beforeId: oldest!.id,
        });
        phase1Messages = result.messages;
        remaining -= result.messages.length;
        lastHasMore = result.has_more;
      }

      // --- Phase 2: If current conv is exhausted AND still have quota, load from previous convs ---
      if (!lastHasMore && remaining > 0) {
        if (prevConvsList.length === 0 && currentHasMoreConvs) {
          const oldestConv = oldestConversationCursorRef.current ?? { id: conversation.id, created_at: conversation.created_at };
          try {
            const result = await listPreviousConversations(agentId, workspaceId, {
              exclude: conversation.id,
              before: oldestConv.created_at,
              channel: currentChannel,
            });
            prevConvsList = result.conversations;
            setPreviousConversations(result.conversations);
            setHasMoreConversations(result.has_more);
          } catch {
            setHasMoreConversations(false);
          }
        }

        let consumed = 0;
        let fetchCount = 0;

        while (
          consumed < prevConvsList.length &&
          remaining > 0 &&
          fetchCount < MAX_CONV_FETCHES_PER_CLICK
        ) {
          const prevConv = prevConvsList[consumed]!;
          consumed++;
          fetchCount++;
          const result = await listMessages(prevConv.id, workspaceId, {
            limit: remaining,
          });

          if (result.messages.length === 0) {
            oldestConversationCursorRef.current = prevConv;
            continue;
          }

          const napTs = oldestConversationCursorRef.current?.created_at ?? conversation.created_at;
          napMarkersToAdd.push({
            agentName: currentAgentName,
            created_at: napTs,
            id: `nap-${prevConv.id}`,
          });

          phase2Messages = [...result.messages, ...phase2Messages];
          remaining -= result.messages.length;
          lastHasMore = result.has_more;
          oldestConversationCursorRef.current = prevConv;
        }

        if (consumed > 0) {
          setPreviousConversations((prev) => prev.slice(consumed));
        }
      }

      // --- Final state update ---
      const allNewMessages = [...phase2Messages, ...phase1Messages];
      flushSync(() => {
        if (allNewMessages.length > 0) {
          if (napMarkersToAdd.length > 0) {
            setNapMarkers((prev) => {
              const existingIds = new Set(prev.map((m) => m.id));
              const newMarkers = napMarkersToAdd.filter((m) => !existingIds.has(m.id));
              return [...prev, ...newMarkers];
            });
          }
          setHasMore(lastHasMore);
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const unique = allNewMessages.filter((m) => !existingIds.has(m.id));
            return [...unique, ...prev];
          });
        } else {
          setHasMore(false);
        }
      });

      loadingMoreRef.current = false;
      flushSync(() => setLoadingMore(false));

      if (el) {
        if (scrollToEnd) {
          el.scrollTop = el.scrollHeight;
        } else {
          const newScrollHeight = el.scrollHeight;
          el.scrollTop = newScrollHeight - prevScrollHeight;
        }
      }
    } catch {
      toast.error("Failed to load older messages");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      if (scrollRef.current) scrollRef.current.style.overflowAnchor = "";
    }
  }, [
    conversation,
    workspaceId,
    agentId,
    messagesRef,
    hasMoreRef,
    hasMoreConvsRef,
    agentNameRef,
    activeChannelRef,
    prevConvsRef,
  ]);

  const canLoadMore = hasMore || previousConversations.length > 0 || hasMoreConversations;

  useEffect(() => {
    if (conversation?.id === prevConversationIdRef.current) return;
    prevConversationIdRef.current = conversation?.id;
    backfillAttemptsRef.current = 0;
  }, [conversation?.id]);

  const MIN_MESSAGES = 10;
  useEffect(() => {
    if (loading || !conversation) return;
    if (messages.length >= MIN_MESSAGES || !canLoadMore) return;
    if (loadingMore) return;
    if (backfillAttemptsRef.current >= 3) return;
    backfillAttemptsRef.current += 1;
    loadOlderMessages(true);
  }, [loading, messages.length, canLoadMore, loadingMore, conversation, loadOlderMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);

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

          if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "superseded") {
            if (isStale) {
              // Stale poll — still merge messages but don't touch activeTask or polling
              listMessages(conversationId, workspaceId)
                .then(({ messages: latest }) => setMessages((prev) => mergeMessages(prev, latest)))
                .catch(() => { });
              return;
            }

            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;

            markInboxRead(conversationId, workspaceId)
              .then(() => refreshInboxCount())
              .catch(() => {});

            const shouldScroll = isNearBottom.current;
            try {
              const [latestResult, arts] = await Promise.all([
                listMessages(conversationId, workspaceId),
                listArtifacts(conversationId, workspaceId).catch(() => null),
              ]);
              setMessages((prev) => mergeMessages(prev, latestResult.messages));
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

            // Fallback: if a follow-up was dispatched but the WebSocket
            // message was lost, detect the new active task via API.
            // Also syncs buffered messages to catch orphans from race conditions.
            setTimeout(async () => {
              if (pollRef.current) return;
              try {
                const [nextTask, latestBuffered] = await Promise.all([
                  getActiveTask(conversationId, workspaceId),
                  listBufferedMessages(conversationId, workspaceId),
                ]);
                setBufferedMessages(latestBuffered);
                if (nextTask && nextTask.id !== taskId) {
                  const { messages: latestMsgs } = await listMessages(conversationId, workspaceId);
                  setMessages((prev) => mergeMessages(prev, latestMsgs));
                  setActiveTask(nextTask);
                  setTaskMessages([]);
                  startPollingRef.current?.(nextTask.id, conversationId);
                }
              } catch { }
            }, 1000);
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
  useEffect(() => {
    startPollingRef.current = startPolling;
  }, [startPolling]);

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
      if (msg.type === "task.created" && msg.conversationId === conversation?.id) {
        listMessages(msg.conversationId, workspaceId)
          .then(({ messages: latest }) => setMessages((prev) => mergeMessages(prev, latest)))
          .catch(() => {});
        const task = msg.task as Task;
        activeTaskIdRef.current = task.id;
        setActiveTask(task);
        setTaskMessages([]);
        lastSeqRef.current = 0;
        startPollingRef.current?.(task.id, msg.conversationId);
      }
      if (msg.type === "conversation.message" && msg.conversationId === conversation?.id) {
        setMessages((prev) => mergeMessages(prev, [msg.message]));
      }
      if (msg.type === "artifact.uploaded" && msg.conversationId === conversation?.id) {
        setArtifacts((prev) => {
          if (prev.some((a) => a.id === msg.artifact.id)) return prev;
          return [...prev, msg.artifact];
        });
      }
      if (msg.type === "followup.dispatched" && msg.conversationId === conversation?.id) {
        // Optimistically remove by real ID
        setBufferedMessages((prev) => prev.filter((m) => m.id !== msg.message.id));
        // Always sync from server to handle temp-ID / duplicate edge cases
        listBufferedMessages(msg.conversationId, workspaceId)
          .then(setBufferedMessages).catch(() => {});
        listMessages(msg.conversationId, workspaceId)
          .then(({ messages: latest }) => setMessages((prev) => mergeMessages(prev, latest)))
          .catch(() => { });
        const task = msg.task as Task;
        activeTaskIdRef.current = task.id;
        setActiveTask(task);
        setTaskMessages([]);
        startPollingRef.current?.(task.id, msg.conversationId);
      }
      if (msg.type === "followup.created" && msg.conversationId === conversation?.id) {
        setBufferedMessages((prev) => addBufferedIfNew(prev, msg.message));
      }
      if (msg.type === "followup.deleted" && msg.conversationId === conversation?.id) {
        setBufferedMessages((prev) => prev.filter((m) => m.id !== msg.messageId));
      }
      if (msg.type === "followup.dispatch_failed" && msg.conversationId === conversation?.id) {
        toast.error(msg.error || "Failed to dispatch follow-up");
      }
    });
  }, [subscribeWs, conversation?.id, workspaceId]);

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

  const handleTextSelect = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      setSelectionPopup(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) { setSelectionPopup(null); return; }
    // Only allow quoting from assistant message bubbles
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!container?.closest("[data-quote-source]")) {
      setSelectionPopup(null);
      return;
    }
    const rects = range.getClientRects();
    const lastRect = rects[rects.length - 1] || range.getBoundingClientRect();
    setSelectionPopup({ text, x: lastRect.right, y: lastRect.top - 4 });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", handleTextSelect);
    return () => document.removeEventListener("selectionchange", handleTextSelect);
  }, [handleTextSelect]);

  const handleQuoteSelection = useCallback(() => {
    if (selectionPopup) {
      setQuotedText(selectionPopup.text);
      setSelectionPopup(null);
      window.getSelection()?.removeAllRanges();
      textareaRef.current?.focus();
    }
  }, [selectionPopup]);

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

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0) return;

    // Prevent default only when we have files to handle
    e.preventDefault();

    const valid: File[] = [];
    for (const file of files) {
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

  const handleStop = async () => {
    if (!conversation || cancelling) return;
    setCancelling(true);
    try {
      const cancelled = await cancelActiveTask(conversation.id, workspaceId);
      if (cancelled) {
        // If WS followup.dispatched already set a new active task, don't overwrite
        if (activeTaskIdRef.current && activeTaskIdRef.current !== cancelled.id) {
          return;
        }
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        const [latestResult, latestBuffered] = await Promise.all([
          listMessages(conversation.id, workspaceId),
          listBufferedMessages(conversation.id, workspaceId),
        ]);
        setMessages((prev) => mergeMessages(prev, latestResult.messages));
        setBufferedMessages(latestBuffered);
        setActiveTask(cancelled as Task);
        setTaskMessages([]);
      }
    } catch {
      toast.error("Failed to cancel task");
    } finally {
      setCancelling(false);
    }
  };

  const handleSend = async () => {
    const rawContent = input.trim();
    if ((!rawContent && pendingFiles.length === 0) || sending || !conversation) return;
    if (!rawContent) {
      toast.error("Please type a message");
      return;
    }

    // Prepend quoted text as blockquote if present
    const content = quotedText
      ? `> ${quotedText.split("\n").join("\n> ")}\n\n${rawContent}`
      : rawContent;

    const filesToSend = [...pendingFiles];
    setInput("");
    setPendingFiles([]);
    setQuotedText(null);
    setSending(true);

    const taskActive = !!activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);

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
        setBufferedMessages((prev) => replaceOptimisticBuffered(prev, optimisticId, message));
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
      setPendingFilesByMessage((prev) => {
        const next = new Map(prev);
        next.set(optimisticId, filesToSend);
        return next;
      });
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
      setPendingFilesByMessage((prev) => {
        if (!prev.has(optimisticId)) return prev;
        const next = new Map(prev);
        next.delete(optimisticId);
        return next;
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === optimistic.id ? message : m))
      );
      if (message.attachment_ids && message.attachment_ids.length > 0) {
        listArtifacts(conversation.id, workspaceId)
          .then((arts) => setArtifacts(arts))
          .catch(() => { });
      }
      setActiveTask(task);
      setTaskMessages([]);
      startPolling(task.id, conversation.id);
    } catch (err) {
      setPendingFilesByMessage((prev) => {
        if (!prev.has(optimisticId)) return prev;
        const next = new Map(prev);
        next.delete(optimisticId);
        return next;
      });
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

  const handleRetryTask = useCallback(async () => {
    if (!activeTask || !conversation) return;
    const newTask = await retryTask(activeTask.id, workspaceId);
    setActiveTask(newTask);
    setTaskMessages([]);
    startPolling(newTask.id, conversation.id);
  }, [activeTask, conversation, workspaceId, startPolling]);

  const openIssue = useCallback(async (issueId: string) => {
    setSelectedIssueId(issueId);
    setIssueSheetOpen(true);
    setIssueDetailLoading(true);
    setIssueTraceTasks(null);
    setIssueActiveTask(null);
    try {
      const res = await getIssue(workspaceId, issueId);
      setIssueDetail(res);
      if (res.issue.latest_task_id) {
        getTask(res.issue.latest_task_id, workspaceId)
          .then(task => setIssueActiveTask(task))
          .catch(() => setIssueActiveTask(null));
      }
      if (res.issue.trace_id) {
        getTrace(res.issue.trace_id, workspaceId)
          .then(t => setIssueTraceTasks(t.tasks))
          .catch(() => setIssueTraceTasks(null));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load issue");
      setIssueSheetOpen(false);
    } finally {
      setIssueDetailLoading(false);
    }
  }, [workspaceId]);

  const issueConvId = issueDetail?.issue?.conversation_id ?? null;
  const issueTaskId = issueDetail?.issue?.latest_task_id ?? null;

  useEffect(() => {
    if (!issueSheetOpen || !selectedIssueId) return;

    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "task.updated" && issueTaskId && msg.taskId === issueTaskId) {
        getTask(issueTaskId, workspaceId)
          .then(task => setIssueActiveTask(task))
          .catch(() => {});
      }
      if (msg.type === "conversation.message" && issueConvId && msg.conversationId === issueConvId) {
        setIssueDetail(prev => {
          if (!prev) return prev;
          if (prev.messages.some(m => m.id === msg.message.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg.message] };
        });
        if (msg.message.role === "event" && msg.message.content.startsWith("Issue status changed:")) {
          const match = msg.message.content.match(/-> (\w+)/);
          if (match) {
            setIssueDetail(prev => prev ? { ...prev, issue: { ...prev.issue, status: match[1] as Issue["status"] } } : prev);
          }
        }
      }
      if (msg.type === "issue.comment" && msg.issueId === selectedIssueId) {
        setIssueDetail(prev => {
          if (!prev) return prev;
          if (prev.comments.some(c => c.id === msg.comment.id)) return prev;
          return { ...prev, comments: [...prev.comments, msg.comment] };
        });
      }
    });
  }, [issueSheetOpen, selectedIssueId, issueConvId, issueTaskId, workspaceId, subscribeWs]);

  const [napping, setNapping] = useState(false);

  const currentConvHasMessages = useMemo(
    () => !!conversation && messages.some((m) => m.conversation_id === conversation.id),
    [conversation, messages],
  );

  const handleNap = async () => {
    if (!conversation || !currentConvHasMessages || napping) return;
    setNapping(true);
    try {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      const newConv = await createConversation(agentId, workspaceId, activeChannel);

      setNapMarkers((prev) => [
        ...prev,
        { agentName, created_at: newConv.created_at, id: `nap-${conversation.id}` },
      ]);

      setPreviousConversations((prev) => [
        { id: conversation.id, created_at: conversation.created_at },
        ...prev,
      ]);

      setConversation(newConv);
      setActiveTask(null);
      setTaskMessages([]);
      setArtifacts([]);
      setBufferedMessages([]);
      setPendingFiles([]);
      setPendingFilesByMessage(new Map());
      lastSeqRef.current = 0;
      setConnectionLost(false);
      setHasMore(false);
      oldestConversationCursorRef.current = null;

      scrollToBottom();
    } catch {
      toast.error("Failed to start new conversation");
    } finally {
      setNapping(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionPopup.handleMentionKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const isTaskActive = !!activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status);

  if (loading) {
    return (
      <>
        <div className="flex-1 overflow-y-auto px-3 md:px-5">
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
        <div className="px-3 md:px-5 py-3">
          <div className="mx-auto max-w-2xl">
            <Skeleton className="h-18 w-full rounded-xl" />
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
      {/* Floating quote button on text selection */}
      {selectionPopup && (
        <button
          type="button"
          className="fixed z-50 flex items-center gap-1 px-2 py-1 rounded-md bg-popover border shadow-md text-xs text-popover-foreground hover:bg-accent transition-colors"
          style={{ left: selectionPopup.x, top: selectionPopup.y, transform: "translate(-100%, -100%)" }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleQuoteSelection}
        >
          <MessageSquareQuote className="size-3" />
          Quote
        </button>
      )}
      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        <div
          className="h-full overflow-y-auto overflow-x-hidden px-3 md:px-5 thin-scrollbar"
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
            {canLoadMore && !loadingMore && (
              <div className="flex justify-center py-2">
                <button
                  onClick={() => loadOlderMessages()}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Load earlier messages
                </button>
              </div>
            )}
            {loadingMore && (
              <div className="flex justify-center py-2">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {messages.length === 0 && !activeTask && (() => {
              const agent = agents.find(a => a.id === agentId);
              const isNewAgent = agent?.created_at && (renderNow - new Date(agent.created_at).getTime() < 5 * 60 * 1000);
              const hasEmailTask = (activeTaskCounts[agentId] ?? 0) > 0;

              if (isNewAgent && hasEmailTask && activeChannel === "default") {
                return (
                  <div className="flex flex-col items-center justify-center py-20 gap-3 animate-[fade-up_400ms_ease-out_both]">
                    <div className="relative animate-bounce">
                      <Mail className="size-8 text-primary" />
                      <span className="absolute -top-1 -right-1 flex size-3">
                        <span className="animate-ping absolute inline-flex size-full rounded-full bg-primary/60" />
                        <span className="relative inline-flex size-3 rounded-full bg-primary" />
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground text-center max-w-xs">
                      Your agent is sending you a welcome email.
                    </p>
                    <p className="text-xs text-muted-foreground/60 text-center max-w-xs">
                      Wait for the email task in the top-left to complete, then check your inbox. Or send a message below to start chatting.
                    </p>
                  </div>
                );
              }

              return (
                <p className="text-center text-muted-foreground py-20 text-sm">
                  Send a message to start chatting with the agent.
                </p>
              );
            })()}

            {timeline.map((item) => {
              if (item.kind === "nap") {
                return <NapSeparator key={item.data.id} agentName={agentName} />;
              }

              if (item.kind === "artifact") {
                return (
                  <ArtifactCard
                    key={`artifact-${item.data.id}`}
                    artifact={item.data}
                    version={versionMap.get(item.data.id) ?? 1}
                    hasDuplicates={duplicateFilenames.has(item.data.filename)}
                    onClick={handleArtifactClick}
                  />
                );
              }

              const msg = item.data;
              return (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  agents={agents}
                  artifacts={artifacts}
                  activeTask={activeTask}
                  taskMessages={taskMessages}
                  connectionLost={connectionLost}
                  isLastMessage={messages.length > 0 && messages[messages.length - 1].id === msg.id}
                  stepCount={msg.task_id ? (stepCounts[msg.task_id] ?? 0) : 0}
                  targetConvId={targetConvId}
                  workspaceId={workspaceId}
                  conversationType={conversation?.type}
                  pendingFilesByMessage={pendingFilesByMessage}
                  onArtifactClick={handleArtifactClick}
                  onEmailClick={(emailId) => {
                    setSelectedEmailId(emailId);
                    setEmailSheetOpen(true);
                  }}
                  onIssueClick={(issueId) => openIssue(issueId)}
                  onRetry={handleRetryTask}
                  mentionComponents={MENTION_COMPONENTS}
                />
              );
            })}

            {/* Show trace while task is in progress (no assistant message yet) */}
            {activeTask && !["completed", "failed", "cancelled", "superseded"].includes(activeTask.status) && (
              <TaskStream
                task={activeTask}
                messages={taskMessages}
                connectionLost={connectionLost}
              />
            )}
          </div>
        </div>
        <ScrollToBottomButton scrollRef={scrollRef} />
      </div>

      {/* Follow-up buffer indicator */}
      {conversation && <FollowUpBuffer
        bufferedMessages={bufferedMessages}
        onDelete={(messageId) => {
          const prev = bufferedMessages;
          setBufferedMessages((cur) => cur.filter((m) => m.id !== messageId));
          deleteBufferedMessage(conversation.id, messageId, workspaceId).catch(() => {
            setBufferedMessages(prev);
            toast.error("Failed to delete follow-up");
          });
        }}
      />}

      {/* Input */}
      <div className="px-3 md:px-5 py-3">
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
            {quotedText && (
              <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1 border-b border-border/50">
                <div className="flex-1 min-w-0 flex items-start gap-2">
                  <MessageSquareQuote className="size-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground truncate">
                    {quotedText.slice(0, 120)}{quotedText.length > 120 ? "..." : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setQuotedText(null)}
                  className="shrink-0 p-0.5 rounded-sm hover:bg-muted-foreground/20 transition-colors text-muted-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            <MentionPopup
              isOpen={mentionPopup.isOpen}
              relatedAgents={mentionPopup.relatedAgents}
              otherAgents={mentionPopup.otherAgents}
              selectedIndex={mentionPopup.selectedIndex}
              onSelect={mentionPopup.selectAgent}
              anchorPos={mentionPopup.anchorPos}
            />
            <div className="relative">
              <div
                aria-hidden
                className="mention-backdrop absolute inset-0 px-3.5 py-2.5 text-base chat-input-line-height whitespace-pre-wrap wrap-break-word pointer-events-none overflow-y-auto thin-scrollbar"
                dangerouslySetInnerHTML={{
                  __html: input
                    ? highlightMentions(
                      input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
                      agents,
                    )
                      .replace(/<mention[^>]*>/g, '<span class="mention-highlight">')
                      .replace(/<\/mention>/g, "</span>")
                    + (input.endsWith("\n") ? "\n" : "")
                    : "",
                }}
              />
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setCaretIndex(e.target.selectionStart);
                  // Sync backdrop scroll after content change (handles paste/delete resize)
                  requestAnimationFrame(() => {
                    const backdrop = e.target.previousElementSibling as HTMLElement | null;
                    if (backdrop) backdrop.scrollTop = e.target.scrollTop;
                  });
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onKeyUp={(e) => setCaretIndex((e.target as HTMLTextAreaElement).selectionStart)}
                onClick={(e) => setCaretIndex((e.target as HTMLTextAreaElement).selectionStart)}
                onSelect={(e) => setCaretIndex((e.target as HTMLTextAreaElement).selectionStart)}
                onScroll={(e) => {
                  const backdrop = (e.target as HTMLTextAreaElement).previousElementSibling;
                  if (backdrop) backdrop.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
                }}
                placeholder={isTaskActive ? "Type a follow-up..." : "Type a message..."}
                rows={1}
                disabled={sending}
                className={cn(
                  "relative field-sizing-content w-full resize-none bg-transparent px-3.5 py-2.5 text-base chat-input-line-height outline-none",
                  "placeholder:text-muted-foreground disabled:cursor-not-allowed",
                  "min-h-9.5 max-h-50 thin-scrollbar",
                  "caret-foreground textarea-text-hidden"
                )}
              />
            </div>

            {/* Pending file pills */}
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3.5 pb-1">
                {pendingFiles.map((file, i) => (
                  <span
                    key={`${file.name}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate max-w-30">{file.name}</span>
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
                {!targetConvId && (
                  <Tooltip>
                    <TooltipTrigger render={(props) => (
                      <span {...props} className={cn("inline-flex", props.className)}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={handleNap}
                          disabled={napping || !conversation || !currentConvHasMessages || isTaskActive}
                          className="rounded-lg text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                        >
                          {napping ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <BedDouble className="size-3.5" />
                          )}
                        </Button>
                      </span>
                    )} />
                    <TooltipContent side="top">
                      {isTaskActive ? "Wait for the task to finish" : currentConvHasMessages ? "Take a nap" : `${agentName} is well-rested and ready to go`}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setArtifactSheetOpen(true)}
                      className="relative rounded-lg text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                    />
                  }>
                    <Box className="size-3.5" />
                    {agentArtifacts.length > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground">
                        {agentArtifacts.length}
                      </span>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="top">Artifacts</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sending}
                      className="rounded-lg text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                    />
                  }>
                    <Paperclip className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent side="top">Attach files</TooltipContent>
                </Tooltip>
                {speechSupported && (
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={toggleSpeech}
                        disabled={sending}
                        className={cn(
                          "rounded-lg transition-colors duration-200",
                          listening
                            ? "text-red-500 hover:text-red-600 bg-red-500/10"
                            : "text-muted-foreground/60 hover:text-foreground"
                        )}
                      />
                    }>
                      <Mic className={cn("size-3.5", listening && "animate-pulse")} />
                    </TooltipTrigger>
                    <TooltipContent side="top">{listening ? "Stop recording" : "Voice input"}</TooltipContent>
                  </Tooltip>
                )}
                {isTaskActive && !input.trim() && !sending ? (
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button
                        size="icon-sm"
                        onClick={handleStop}
                        disabled={cancelling}
                        className="rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors duration-200"
                      />
                    }>
                      {cancelling ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Square className="size-3.5 fill-current" />
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="top">Stop task</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={
                      <Button
                        size="icon-sm"
                        onClick={handleSend}
                        disabled={!input.trim() || sending}
                        className={cn(
                          "rounded-lg transition-opacity duration-200",
                          !input.trim() && "opacity-40"
                        )}
                      />
                    }>
                      {sending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ArrowUp className="size-3.5" />
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="top">Send</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <ArtifactSheet
        open={artifactSheetOpen}
        onOpenChange={(v) => {
          setArtifactSheetOpen(v);
          if (!v) setTimeout(() => setSelectedArtifact(null), 300);
        }}
        artifacts={agentArtifacts}
        workspaceId={workspaceId}
        initialArtifact={selectedArtifact}
        versionMap={versionMap}
        duplicateFilenames={duplicateFilenames}
      />

      <EmailEventSheet
        open={emailSheetOpen}
        onOpenChange={(v) => {
          setEmailSheetOpen(v);
          if (!v) setTimeout(() => setSelectedEmailId(null), 300);
        }}
        emailId={selectedEmailId}
        workspaceId={workspaceId}
      />

      <IssueSheet
        open={issueSheetOpen}
        onOpenChange={(v) => {
          setIssueSheetOpen(v);
          if (!v) setTimeout(() => {
            setSelectedIssueId(null);
            setIssueDetail(null);
            setIssueActiveTask(null);
          }, 300);
        }}
        agents={agents}
        issue={issueDetail?.issue ?? null}
        detail={issueDetail ? {
          messages: issueDetail.messages,
          comments: issueDetail.comments,
          artifacts: issueDetail.artifacts,
          traceId: issueDetail.issue.trace_id,
        } : null}
        detailLoading={issueDetailLoading}
        activeTask={issueActiveTask}
        traceTasks={issueTraceTasks}
        slug={slug}
        workspaceId={workspaceId}
        width={issueSidecarWidth}
        onWidthChange={setIssueSidecarWidth}
        onUpdate={async (issueId, patch) => {
          try {
            const updated = await updateIssue(workspaceId, issueId, patch);
            setIssueDetail(prev => prev && prev.issue.id === issueId ? { ...prev, issue: { ...prev.issue, ...patch, updated_at: updated.updated_at } } : prev);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to update issue");
          }
        }}
        onStatusChange={async (issueId, status) => {
          try {
            await updateIssue(workspaceId, issueId, { status: status as Issue["status"] });
            setIssueDetail(prev => prev && prev.issue.id === issueId ? { ...prev, issue: { ...prev.issue, status: status as Issue["status"] } } : prev);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to update status");
          }
        }}
        onCommented={() => {
          if (selectedIssueId) openIssue(selectedIssueId);
        }}
      />
    </>
  );
}
