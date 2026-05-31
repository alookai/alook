"use client";

import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { flushSync } from "react-dom";
import { useParams, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { TaskStream } from "@/components/task-stream";
import {
  chatInit,
  checkFreshness,
  conversationInit,
  createConversation,
  listMessages,
  listMessagesAroundTask,
  listPreviousConversations,
  sendMessage,
  getTask,
  getTaskMessages,
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
  listFlaggedMessageIds,
  flagMessage as apiFlagMessage,
  unflagMessage as apiUnflagMessage,
  getAgentSkills,
} from "@/lib/api";
import {
  appendCachedMessage,
  getCachedMessages,
  getCachedMessagesBefore,
  getCacheMeta,
  mergeCachedMessages,
  getLastOpenConversation,
  setLastOpenConversation,
} from "@/lib/chat-cache";
import {
  createFastLoadGateState,
  fastLoadKey,
  shouldSkipFastLoad,
  markFastLoadCompleted,
} from "@/components/agent-chat/fast-load-gate";
import type { PreviousConversation, TraceTask } from "@/lib/api";
import type {
  Artifact,
  Conversation,
  Issue,
  IssueComment,
  Message,
  SkillEntry,
  TaskApi as Task,
  TaskMessageResponse,
  WsMessage,
} from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { useInboxCount } from "@/contexts/inbox-count-context";
import { useFlagCount } from "@/contexts/flag-count-context";
import { useChannel } from "@/contexts/channel-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  ArrowUp,
  BedDouble,
  Box,
  FileText,
  Loader2,
  Mail,
  MessageSquareQuote,
  MoreHorizontal,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { useCachedMessages } from "@/hooks/use-cached-messages";
import { useSlashCommand } from "@/hooks/use-slash-command";
import { SlashCommandPopup } from "@/components/agent-chat/slash-command-popup";
import {
  ChatComposer,
  type ChatComposerHandle,
} from "@/components/agent-chat/chat-composer";
import {
  ArtifactSheet,
  formatSize,
} from "@/components/agent-chat/artifact-sheet";
import { EmailEventSheet } from "@/components/agent-chat/email-event-sheet";
import { CalendarEventSheet } from "@/components/calendar/calendar-event-sheet";
import { IssueSheet } from "@/components/issues/issue-sheet";
import {
  isPreviewable,
  getArtifactUrl,
  computeArtifactVersions,
} from "@/components/artifact-content-renderer";
import { FollowUpBuffer } from "@/components/agent-chat/follow-up-buffer";
import { ScrollToBottomButton } from "@/components/ui/scroll-to-bottom-button";
import { MessageItem } from "@/components/agent-chat/message-list";
import { AgentPreviewCard } from "@/components/agent-preview-card";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";

const MESSAGE_LIMIT = 20;
const MAX_CONV_FETCHES_PER_CLICK = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function MentionHighlight(
  props: Record<string, unknown> & { children?: React.ReactNode },
) {
  const { children, ...rest } = props;
  const { agents } = useAgentContext();
  const agentId = (rest["data-agent-id"] ?? rest.dataAgentId) as
    | string
    | undefined;
  let agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  if (!agent && typeof children === "string") {
    const nameToMatch = children.startsWith("@") ? children.slice(1) : children;
    agent = agents.find(
      (a) => a.name.toLowerCase() === nameToMatch.toLowerCase(),
    );
  }
  if (agent) {
    return (
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={300}
          nativeButton={false}
          render={<span className="mention-highlight cursor-pointer" />}
        >
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
const MENTION_COMPONENTS: Record<
  string,
  React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>
> = {
  mention: MentionHighlight,
  p: ({
    children,
    node,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) => {
    void node;
    return (
      <div data-md-p="" {...rest}>
        {children}
      </div>
    );
  },
};

type EventIconType = "issue" | "email" | "calendar";

export function getEventIconType(
  content: string,
  conversationType?: string | null,
): EventIconType {
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
export function mergeMessages(
  existing: Message[],
  incoming: Message[],
): Message[] {
  const merged = new Map<string, Message>();
  for (const m of existing) merged.set(m.id, m);
  for (const m of incoming) merged.set(m.id, m);
  return sortMessages([...merged.values()]);
}

export function addBufferedIfNew(
  prev: Message[],
  incoming: Message,
): Message[] {
  if (prev.some((m) => m.id === incoming.id)) return prev;
  // Skip if there's a recent optimistic entry — avoids brief duplicate flash
  // when WS followup.created arrives before createBufferedMessage HTTP response.
  const t = new Date(incoming.created_at).getTime();
  if (
    prev.some(
      (m) =>
        m.id.startsWith("temp-") &&
        Math.abs(new Date(m.created_at).getTime() - t) < 2000,
    )
  ) {
    return prev;
  }
  return [...prev, incoming];
}

export function replaceOptimisticBuffered(
  prev: Message[],
  optimisticId: string,
  real: Message,
): Message[] {
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

export type GroupPosition = "first" | "middle" | "last" | "solo";

function computeGroupPositions(
  timeline: TimelineItem[],
): (GroupPosition | null)[] {
  const positions: (GroupPosition | null)[] = new Array(timeline.length).fill(
    null,
  );
  const GROUP_THRESHOLD_MS = 60_000;

  // Only user/assistant messages group into tight iMessage-style stacks.
  // Event messages (email/issue/calendar notifications) must keep normal spacing.
  const isGroupable = (m: Message) =>
    m.role === "user" || m.role === "assistant";

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (item.kind !== "message") continue;

    const msg = item.data as Message;
    if (!isGroupable(msg)) continue; // leave as null → normal mt-4 spacing, full rounding

    const prev = i > 0 ? timeline[i - 1] : null;
    const next = i < timeline.length - 1 ? timeline[i + 1] : null;

    const sameAsPrev =
      prev?.kind === "message" &&
      isGroupable(prev.data as Message) &&
      (prev.data as Message).role === msg.role &&
      (!msg.created_at ||
        !(prev.data as Message).created_at ||
        Math.abs(
          new Date(msg.created_at).getTime() -
            new Date((prev.data as Message).created_at).getTime(),
        ) < GROUP_THRESHOLD_MS);

    const sameAsNext =
      next?.kind === "message" &&
      isGroupable(next.data as Message) &&
      (next.data as Message).role === msg.role &&
      (!msg.created_at ||
        !(next.data as Message).created_at ||
        Math.abs(
          new Date((next.data as Message).created_at).getTime() -
            new Date(msg.created_at).getTime(),
        ) < GROUP_THRESHOLD_MS);

    if (sameAsPrev && sameAsNext) positions[i] = "middle";
    else if (sameAsPrev && !sameAsNext) positions[i] = "last";
    else if (!sameAsPrev && sameAsNext) positions[i] = "first";
    else positions[i] = "solo";
  }

  return positions;
}

export function reorderArtifactsAfterAssistant(
  items: TimelineItem[],
): TimelineItem[] {
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
  const sortedNaps = [...napMarkers].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

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
  const orphanMsgs = messages.filter(
    (m) => !knownConvIds.has(m.conversation_id),
  );
  const orphanArts = artifacts.filter(
    (a) => !knownConvIds.has(a.conversation_id),
  );
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

/**
 * Whether a completed conversation load may persist the per-channel `last_open`
 * pointer. Only the SLOW path (param-less open, `targetConvId` absent) resolves
 * the channel's latest-created conversation; the FAST path (`?conv=<id>`) loads
 * an explicit, possibly old conversation and must NOT touch the pointer (doing
 * so reintroduces the wrong-conversation flash). See {@link LastOpenEntry}.
 *
 * Pure mirror of the inline Phase B write guard, exported for unit testing the
 * fast-vs-slow decision without rendering the component.
 */
export function shouldPersistPointerForLoad(
  targetConvId: string | null | undefined,
): boolean {
  return !targetConvId;
}

/**
 * Decide whether a `task.created` WS event should refresh this view's
 * per-channel `last_open` pointer, and to which conversation.
 *
 * The `last_open` pointer carries "latest-created conversation for this
 * agent+channel" semantics (see {@link setLastOpenConversation}). A
 * `task.created` event is the client learning of a (possibly newer)
 * conversation in real time, so it is a valid moment to refresh the pointer —
 * but ONLY when the event belongs to exactly this agent + active channel.
 *
 * Returns the conversation id to point at, or `null` to skip the write
 * (different agent, different channel, or the pointer already points there).
 *
 * Pure so the scoping logic is unit-testable in the node-env web test suite
 * (no component render). The caller supplies `serverMessageCount` separately
 * (A1: derived from the locally-cached message count) when it performs the
 * actual `setLastOpenConversation` write.
 */
export function pointerRefreshTargetForTaskCreated(args: {
  /** The TaskApi from the `task.created` event. */
  task: Pick<Task, "agent_id" | "channel" | "conversation_id">;
  /** The agent this view is rendering. */
  agentId: string;
  /** The active channel string (never null — null maps to "default"). */
  activeChannel: string;
  /** The conversation id the pointer currently references, if known. */
  currentPointerConvId: string | null;
}): string | null {
  const { task, agentId, activeChannel, currentPointerConvId } = args;
  // Scope guard: never touch another agent's or channel's pointer. The event's
  // null channel normalizes to "default" to match the UI's channel string
  // (channel-context.tsx). activeChannel is always a non-null string.
  if (task.agent_id !== agentId) return null;
  if ((task.channel ?? "default") !== activeChannel) return null;
  // Already pointing here — nothing to do.
  if (task.conversation_id === currentPointerConvId) return null;
  return task.conversation_id;
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

function ArtifactCard({
  artifact,
  version,
  hasDuplicates,
  onClick,
}: {
  artifact: Artifact;
  version: number;
  hasDuplicates: boolean;
  onClick: (a: Artifact) => void;
}) {
  return (
    <button
      onClick={() => onClick(artifact)}
      className={cn(
        "flex items-center gap-3 w-full max-w-sm rounded-lg border border-border/60 bg-muted/30",
        "px-3.5 py-2.5 text-left transition-colors duration-150",
        "hover:bg-muted/60 hover:border-border",
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
        <p className="text-xs text-muted-foreground">
          {formatSize(artifact.size)}
        </p>
      </div>
    </button>
  );
}

export function AgentChatView({
  agentId: propAgentId,
  targetConvId: propTargetConvId,
  scrollToTaskId: propScrollToTaskId,
  scrollToMessageId: propScrollToMessageId,
}: {
  agentId?: string;
  targetConvId?: string | null;
  scrollToTaskId?: string | null;
  scrollToMessageId?: string | null;
}) {
  const params = useParams();
  const searchParams = useSearchParams();
  const { workspaceId, slug } = useWorkspace();
  const {
    agents,
    agentLinks,
    activeTaskCounts,
    subscribeWs,
    subscribeReconnect,
  } = useAgentContext();
  const { refresh: refreshInboxCount } = useInboxCount();
  const {
    activeChannel,
    loading: channelLoading,
    setAgentId: setChannelAgentId,
  } = useChannel();
  const agentId = propAgentId ?? (params.id as string);
  const scrollToTaskId =
    propScrollToTaskId !== undefined
      ? propScrollToTaskId
      : searchParams.get("task");
  const scrollToMessageId =
    propScrollToMessageId !== undefined
      ? propScrollToMessageId
      : searchParams.get("msg");
  const targetConvId =
    propTargetConvId !== undefined
      ? propTargetConvId
      : searchParams.get("conv");

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return (
      localStorage.getItem(
        `chat-draft:${agentId}:${targetConvId ?? "default"}`,
      ) ?? ""
    );
  });
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessageResponse[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactSheetOpen, setArtifactSheetOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(
    null,
  );
  const [artifactSheetSource, setArtifactSheetSource] = useState<
    "agent" | "issue" | null
  >(null);
  const [emailSheetOpen, setEmailSheetOpen] = useState(false);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [calendarEventSheetOpen, setCalendarEventSheetOpen] = useState(false);
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<
    string | null
  >(null);
  const [issueSheetOpen, setIssueSheetOpen] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [issueDetail, setIssueDetail] = useState<{
    issue: Issue & { trace_id?: string | null };
    messages: Message[];
    comments: IssueComment[];
    artifacts: Artifact[];
  } | null>(null);
  const [issueDetailLoading, setIssueDetailLoading] = useState(false);
  const [issueTraceTasks, setIssueTraceTasks] = useState<TraceTask[] | null>(
    null,
  );
  const [issueActiveTask, setIssueActiveTask] = useState<Task | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [bufferedMessages, setBufferedMessages] = useState<Message[]>([]);
  const [caretIndex, setCaretIndex] = useState<number | null>(null);
  const [previousConversations, setPreviousConversations] = useState<
    PreviousConversation[]
  >([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [napMarkers, setNapMarkers] = useState<NapMarker[]>([]);
  const [thinkingCounts, setThinkingCounts] = useState<Record<string, number>>(
    {},
  );
  const [renderNow] = useState(() => Date.now());

  const [pendingFilesByMessage, setPendingFilesByMessage] = useState<
    Map<string, File[]>
  >(() => new Map());
  const [quotedText, setQuotedText] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const meta = JSON.parse(
        localStorage.getItem(
          `chat-draft-meta:${agentId}:${targetConvId ?? "default"}`,
        ) ?? "null",
      );
      return meta?.quote ?? null;
    } catch {
      return null;
    }
  });
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [selectionPopup, setSelectionPopup] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const flaggedIdsRef = useRef(flaggedIds);
  useEffect(() => {
    flaggedIdsRef.current = flaggedIds;
  });

  const {
    increment: flagIncrement,
    decrement: flagDecrement,
    refresh: flagRefresh,
  } = useFlagCount();

  const { writeToCache } = useCachedMessages(targetConvId ?? null, workspaceId);
  const writeToCacheRef = useRef(writeToCache);
  useEffect(() => {
    writeToCacheRef.current = writeToCache;
  }, [writeToCache]);

  useEffect(() => {
    setChannelAgentId(agentId);
  }, [agentId, setChannelAgentId]);

  const agentArtifacts = useMemo(
    () => artifacts.filter((a) => a.source === "agent"),
    [artifacts],
  );

  const { versionMap, duplicateFilenames } = useMemo(
    () => computeArtifactVersions(agentArtifacts),
    [agentArtifacts],
  );

  const artifactSheetArtifacts = useMemo(
    () =>
      artifactSheetSource === "agent"
        ? agentArtifacts
        : artifactSheetSource === "issue"
          ? (issueDetail?.artifacts ?? [])
          : [],
    [artifactSheetSource, agentArtifacts, issueDetail?.artifacts],
  );
  const {
    versionMap: artifactSheetVersionMap,
    duplicateFilenames: artifactSheetDuplicateFilenames,
  } = useMemo(
    () => computeArtifactVersions(artifactSheetArtifacts),
    [artifactSheetArtifacts],
  );

  const timeline = useMemo(
    () => buildTimeline(messages, agentArtifacts, napMarkers, conversation?.id),
    [messages, agentArtifacts, napMarkers, conversation?.id],
  );
  const groupPositions = useMemo(
    () => computeGroupPositions(timeline),
    [timeline],
  );

  const handleArtifactClick = useCallback(
    (artifact: Artifact) => {
      if (isPreviewable(artifact)) {
        setSelectedArtifact(artifact);
        setArtifactSheetSource("agent");
        setArtifactSheetOpen(true);
      } else {
        window.open(getArtifactUrl(artifact.id, workspaceId, true), "_blank");
      }
    },
    [workspaceId],
  );

  const handleIssueArtifactClick = useCallback(
    (artifact: Artifact) => {
      if (isPreviewable(artifact)) {
        setSelectedArtifact(artifact);
        setArtifactSheetSource("issue");
        setArtifactSheetOpen(true);
      } else {
        window.open(getArtifactUrl(artifact.id, workspaceId, true), "_blank");
      }
    },
    [workspaceId],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTaskIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const pollFailures = useRef(0);
  const initialScrollDone = useRef(false);
  const loadingMoreRef = useRef(false);
  const isNearBottom = useRef(true);
  const scrollTargetActiveRef = useRef(false);
  const startPollingRef = useRef<
    | ((taskId: string, conversationId: string, initialSeq?: number) => void)
    | null
  >(null);
  const oldestConversationCursorRef = useRef<PreviousConversation | null>(null);
  const backfillAttemptsRef = useRef(0);
  const prevConversationIdRef = useRef<string | undefined>(undefined);
  // The server-confirmed conversation id for the current load. Cache writes
  // (mergeCachedMessages / appendCachedMessage / setLastOpenConversation) must
  // guard on this so a write never lands on an optimistically-rendered (not yet
  // confirmed) conversation during the cache-first window. Stays null until
  // checkFreshness / chatInit / conversationInit confirms an id.
  const loadConvIdRef = useRef<string | null>(null);
  // Dedup gate for the fast-path load: skips a redundant re-run when only
  // channel deps (activeChannel / channelLoading) change, WITHOUT stranding the
  // skeleton if a run is cancelled mid-flight. See fast-load-gate.ts (Part 2-a /
  // TODO 6 + stuck-skeleton fix).
  const fastLoadGateRef = useRef(createFastLoadGateState());
  const fileInputRef = useRef<HTMLInputElement>(null);
  // TipTap composer imperative handle (focus / clear / isEmpty / anchor coords).
  const composerRef = useRef<ChatComposerHandle>(null);
  // Editor plain text + caret, reported up from the composer, drive the
  // slash-command popup (mentions are handled natively inside the composer).
  const [editorText, setEditorText] = useState("");

  const otherAgents = useMemo(
    () => agents.filter((a) => a.id !== agentId),
    [agents, agentId],
  );

  // Slash command skills — fetch from D1 on mount
  const [agentSkills, setAgentSkills] = useState<SkillEntry[]>([]);
  const skillsFetchedRef = useRef(false);
  const draftMetaRestoredRef = useRef(false);

  useEffect(() => {
    if (skillsFetchedRef.current) return;
    skillsFetchedRef.current = true;
    getAgentSkills(agentId, workspaceId)
      .then((res) => setAgentSkills(res.skills as SkillEntry[]))
      .catch(() => {});
  }, [agentId, workspaceId]);

  const [initialActiveSkill] = useState<SkillEntry | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const meta = JSON.parse(
        localStorage.getItem(
          `chat-draft-meta:${agentId}:${targetConvId ?? "default"}`,
        ) ?? "null",
      );
      return meta?.skill ?? null;
    } catch {
      return null;
    }
  });

  const slashCommand = useSlashCommand({
    input: editorText,
    caretIndex,
    skills: agentSkills,
    onInputChange: () => composerRef.current?.clear(),
    initialActiveSkill,
    getAnchorPos: useCallback(
      (triggerStart: number) =>
        composerRef.current?.coordsAtTextIndex(triggerStart) ?? null,
      [],
    ),
    onAfterSelect: useCallback(() => {
      requestAnimationFrame(() => composerRef.current?.focus());
    }, []),
  });

  useEffect(() => {
    if (agentSkills.length === 0 || !slashCommand.activeSkill) return;
    const exists = agentSkills.some(
      (s) => s.name === slashCommand.activeSkill!.name,
    );
    if (!exists) slashCommand.setActiveSkill(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omits slashCommand; only re-validate when the skills list itself changes
  }, [agentSkills]);

  useEffect(() => {
    const key = `chat-draft:${agentId}:${targetConvId ?? "default"}`;
    if (input) {
      localStorage.setItem(key, input);
    } else {
      localStorage.removeItem(key);
    }
  }, [input, agentId, targetConvId]);

  useEffect(() => {
    if (!draftMetaRestoredRef.current) return;
    const key = `chat-draft-meta:${agentId}:${targetConvId ?? "default"}`;
    const meta: {
      skill?: { name: string; description: string } | null;
      quote?: string | null;
    } = {};
    if (slashCommand.activeSkill) {
      meta.skill = {
        name: slashCommand.activeSkill.name,
        description: slashCommand.activeSkill.description,
      };
    }
    if (quotedText) {
      meta.quote = quotedText;
    }
    if (meta.skill || meta.quote) {
      localStorage.setItem(key, JSON.stringify(meta));
    } else {
      localStorage.removeItem(key);
    }
  }, [slashCommand.activeSkill, quotedText, agentId, targetConvId]);

  useEffect(() => {
    if (!sending) {
      composerRef.current?.focus();
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
    // The slow path (no targetConvId) resolves the conversation id via the
    // server using activeChannel, so it must wait for the channel list. The
    // fast path (known targetConvId) and the cache-first optimistic paint need
    // neither activeChannel nor a loaded channel list, so they must NOT be
    // gated by channelLoading (Part 2-a). channelLoading stays in the dep array
    // so the slow path retries once channels load.
    if (!targetConvId && channelLoading) return;

    // Fast path: ignore channel-only dep changes (TODO 6). shouldSkipFastLoad
    // returns true only when a load for this identity has already COMPLETED, and
    // otherwise clears the completed marker so a run cancelled mid-flight leaves
    // no "done" marker — the recovery run then proceeds and clears the skeleton
    // instead of getting stuck forever. See fast-load-gate.ts.
    const fastKey = fastLoadKey({
      workspaceId,
      agentId,
      targetConvId,
      scrollToTaskId,
    });
    if (shouldSkipFastLoad(fastKey, fastLoadGateRef.current)) return;

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    pollTaskIdRef.current = null;
    loadConvIdRef.current = null;
    let ignore = false;
    setMessagesLoading(true);
    initialScrollDone.current = false;
    setActiveTask(null);
    setTaskMessages([]);
    setBufferedMessages([]);
    setPendingFilesByMessage(new Map());
    setNapMarkers([]);
    setThinkingCounts({});
    setPreviousConversations([]);
    setHasMoreConversations(false);
    oldestConversationCursorRef.current = null;
    setInput(
      localStorage.getItem(
        `chat-draft:${agentId}:${targetConvId ?? "default"}`,
      ) ?? "",
    );
    const metaRaw = localStorage.getItem(
      `chat-draft-meta:${agentId}:${targetConvId ?? "default"}`,
    );
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw);
        setQuotedText(meta.quote ?? null);
        slashCommand.setActiveSkill(
          meta.skill ? (meta.skill as SkillEntry) : null,
        );
      } catch {
        setQuotedText(null);
        slashCommand.setActiveSkill(null);
      }
    } else {
      setQuotedText(null);
      slashCommand.setActiveSkill(null);
    }
    draftMetaRestoredRef.current = true;
    setMessages([]);

    // Paint cached messages for a known conversation id without any network.
    // Returns true if it painted, so the caller can suppress the loading
    // skeleton until the background reconcile runs.
    async function paintFromCache(convId: string): Promise<{
      painted: boolean;
      cacheMeta: Awaited<ReturnType<typeof getCacheMeta>>;
    }> {
      const cacheMeta = await getCacheMeta(convId, workspaceId);
      if (cacheMeta?.newestMessageId) {
        const cached = await getCachedMessages(convId, workspaceId);
        if (ignore) return { painted: false, cacheMeta };
        if (cached && cached.length > 0) {
          setMessages(cached);
          setHasMore(cacheMeta.hasMore);
          setMessagesLoading(false);
          return { painted: true, cacheMeta };
        }
      }
      return { painted: false, cacheMeta };
    }

    async function load() {
      let hasCachedMessages = false;
      try {
        let convId: string | null = null;
        let cacheMeta: Awaited<ReturnType<typeof getCacheMeta>> = null;
        // The id we optimistically painted in the slow path; reconciled against
        // the server-confirmed id once checkFreshness returns.
        let optimisticConvId: string | null = null;

        if (targetConvId) {
          // Fast path: we already know the conv ID — render from cache immediately, no network needed
          convId = targetConvId;
          const res = await paintFromCache(convId);
          if (ignore) return;
          cacheMeta = res.cacheMeta;
          hasCachedMessages = res.painted;
        } else {
          // Slow path: resolve the conversation id locally first (last-open
          // pointer) and paint its cache immediately, then verify in the
          // background. Only paint optimistically when the pointer is plausibly
          // fresh (serverMessageCount > 0 and a non-empty cache), so a stale or
          // empty pointer falls back to the skeleton (review #4).
          //
          // The pointer now carries "latest-created conversation for this
          // agent+channel" semantics (see {@link setLastOpenConversation} and the
          // gated write in Phase B / the task.created WS handler), matching the
          // server's `check-fresh` definition of "current" (latest-created). So
          // the optimistic paint is correct-by-construction: in the common case
          // the painted id equals the check-fresh id below → no swap → no flash.
          // Do NOT reintroduce "last opened" semantics here (e.g. by writing the
          // pointer from a `?conv=` fast-path open) — that is exactly the bug this
          // fix removed.
          const lastOpen = await getLastOpenConversation(
            agentId,
            activeChannel,
            workspaceId,
          );
          if (ignore) return;
          if (lastOpen?.conversation_id && lastOpen.serverMessageCount > 0) {
            const res = await paintFromCache(lastOpen.conversation_id);
            if (ignore) return;
            if (res.painted) {
              hasCachedMessages = true;
              optimisticConvId = lastOpen.conversation_id;
              cacheMeta = res.cacheMeta;
            }
          }

          // Background freshness check — does NOT gate the paint above.
          try {
            const fresh = await checkFreshness(
              { agentId, channel: activeChannel },
              workspaceId,
            );
            if (ignore) return;
            convId = fresh.conversation_id;

            if (optimisticConvId && convId !== optimisticConvId) {
              // We painted the wrong/stale conversation. Swap to the correct
              // one and reset scroll intent so the initial-scroll effect
              // re-fires for the new message set (review #2).
              initialScrollDone.current = false;
              isNearBottom.current = true;
              const res = await paintFromCache(convId);
              if (ignore) return;
              cacheMeta = res.cacheMeta;
              hasCachedMessages = res.painted;
              if (!res.painted) {
                // The correct conversation has no cache — clear the stale
                // optimistic render so the Phase B merge below starts from an
                // empty list instead of mixing conversation A's messages into B.
                setMessages([]);
                setMessagesLoading(true);
              }
            } else if (!optimisticConvId) {
              // Nothing painted yet — read the resolved conversation's cache.
              const res = await paintFromCache(convId);
              if (ignore) return;
              cacheMeta = res.cacheMeta;
              hasCachedMessages = res.painted;
            }
            // else: optimistic id matched the confirmed id — keep the paint.
            //
            // We always fall through to Phase B: even when the cache is fresh
            // (idMatches && countMatches), conversationInit returns cache_valid
            // and is still needed for conversation meta / tasks / artifacts, and
            // it does NOT re-set messages — so a fresh cache means exactly one
            // setMessages (the instant paint), no flicker. Phase B also writes
            // the server-confirmed last_open pointer for both fresh and stale.
          } catch {
            // checkFreshness failed — fall back to chatInit below
          }
        }

        // Phase B: full data fetch (background hydration or stale-cache refresh)
        if (convId) {
          loadConvIdRef.current = convId;
          const data = await conversationInit(convId, workspaceId, {
            newestMessageId: cacheMeta?.newestMessageId ?? undefined,
            // 0 means "count unknown" (e.g. cached via the chatInit fallback,
            // which has no server total) — omit the param so the server skips
            // the count compare and relies on newestMessageId alone. Sending
            // "0" would make the server's `serverMessageCount === 0` check fail
            // for every non-empty conversation, forcing a needless full merge.
            messageCount: cacheMeta?.serverMessageCount || undefined,
          });
          if (ignore) return;
          setConversation(data.conversation);
          setHasMoreConversations(data.has_more_conversations);
          if (!data.cache_valid && data.messages) {
            // Stale cache — merge server data in place, preserving scroll
            // position unless the user was already near the bottom (A2 / TODO 5).
            const wasNearBottom = isNearBottom.current;
            setMessages((prev) => mergeMessages(prev, data.messages!));
            if (loadConvIdRef.current === convId) {
              mergeCachedMessages(
                convId,
                data.messages,
                data.has_more_messages,
                workspaceId,
                data.message_count,
              ).catch(() => {});
            }
            setHasMore(data.has_more_messages);
            if (
              hasCachedMessages &&
              initialScrollDone.current &&
              wasNearBottom
            ) {
              scrollToBottom();
            }
          } else if (cacheMeta) {
            setHasMore(cacheMeta.hasMore);
          }
          // Record the last-open pointer with server-confirmed freshness so the
          // next param-less open can resolve this conversation locally. Re-read
          // the cache meta (just updated by mergeCachedMessages on the stale
          // path) so the stored newest id is authoritative rather than inferred
          // from page order.
          //
          // GATED on `!targetConvId`: only the SLOW path (param-less, server-
          // resolved) may write the pointer. On the FAST path `convId ===
          // targetConvId` — an explicit, possibly OLD conversation the user
          // navigated to via `?conv=`. Persisting that would re-corrupt the
          // pointer back to "last-opened" semantics and reintroduce the
          // wrong-conversation flash on the next param-less open. The pointer
          // must only ever carry the channel's latest-created conversation.
          if (
            loadConvIdRef.current === convId &&
            shouldPersistPointerForLoad(targetConvId)
          ) {
            const confirmedMeta = await getCacheMeta(convId, workspaceId);
            if (ignore) return;
            setLastOpenConversation(
              agentId,
              activeChannel,
              {
                conversation_id: convId,
                newestMessageId:
                  confirmedMeta?.newestMessageId ??
                  cacheMeta?.newestMessageId ??
                  null,
                serverMessageCount: data.message_count,
              },
              workspaceId,
            ).catch(() => {});
          }
          setThinkingCounts(data.thinking_counts);
          setArtifacts(data.artifacts);
          setBufferedMessages(data.buffered_messages);
          setFlaggedIds(new Set(data.flagged_message_ids));
          if (data.active_task) {
            setActiveTask(data.active_task);
            setTaskMessages(data.task_messages);
            if (data.task_messages.length > 0) {
              lastSeqRef.current = Math.max(
                ...data.task_messages.map((m) => m.seq),
              );
            }
            startPollingRef.current?.(
              data.active_task.id,
              convId,
              lastSeqRef.current,
            );
          }
          if (scrollToTaskId) {
            const task = await getTask(scrollToTaskId, workspaceId).catch(
              () => null,
            );
            if (ignore) return;
            if (
              task &&
              !["completed", "failed", "cancelled", "superseded"].includes(
                task.status,
              )
            ) {
              setActiveTask(task);
              const tmsgs = await getTaskMessages(
                scrollToTaskId,
                workspaceId,
              ).catch(() => [] as TaskMessageResponse[]);
              if (ignore) return;
              setTaskMessages(tmsgs);
              if (tmsgs.length > 0) {
                lastSeqRef.current = Math.max(...tmsgs.map((m) => m.seq));
              }
              startPollingRef.current?.(task.id, convId, lastSeqRef.current);
            }
          }
        } else {
          // checkFreshness failed entirely — fall back to chatInit
          const data = await chatInit(agentId, workspaceId, activeChannel);
          if (ignore) return;
          loadConvIdRef.current = data.conversation.id;
          setConversation(data.conversation);
          const wasNearBottom = isNearBottom.current;
          setMessages((prev) =>
            prev.length > 0
              ? mergeMessages(prev, data.messages)
              : data.messages,
          );
          setHasMore(data.has_more_messages);
          setArtifacts(data.artifacts);
          setBufferedMessages(data.buffered_messages);
          setHasMoreConversations(data.has_more_conversations);
          mergeCachedMessages(
            data.conversation.id,
            data.messages,
            data.has_more_messages,
            workspaceId,
          ).catch(() => {});
          // This branch is reached only when `convId` is null — i.e. the SLOW
          // path's checkFreshness failed and we fell back to chatInit. chatInit
          // returns the server's current (latest-created) conversation, so this
          // write carries the correct "latest-created" semantics. It is
          // slow-path-only by construction (the fast path sets convId =
          // targetConvId and never falls through here), so no `!targetConvId`
          // gate is needed.
          setLastOpenConversation(
            agentId,
            activeChannel,
            {
              conversation_id: data.conversation.id,
              newestMessageId:
                data.messages.length > 0
                  ? data.messages[data.messages.length - 1].id
                  : null,
              // chatInit returns no server total; data.messages is only the first
              // page. When more pages exist, the count is unknown — store 0, which
              // the read site treats as "unknown" and omits from the freshness
              // compare (relying on newestMessageId instead). Storing the partial
              // page length would otherwise force a needless full merge next open.
              serverMessageCount: data.has_more_messages
                ? 0
                : data.messages.length,
            },
            workspaceId,
          ).catch(() => {});
          if (hasCachedMessages && initialScrollDone.current && wasNearBottom) {
            scrollToBottom();
          }
          listFlaggedMessageIds(workspaceId, data.conversation.id)
            .then((r) => {
              if (!ignore) setFlaggedIds(new Set(r.message_ids));
            })
            .catch(() => {});
          if (data.active_task) {
            setActiveTask(data.active_task);
            if (data.task_messages.length > 0) {
              setTaskMessages(data.task_messages);
              lastSeqRef.current = Math.max(
                ...data.task_messages.map((m) => m.seq),
              );
            }
            if (
              !["completed", "failed", "cancelled", "superseded"].includes(
                data.active_task.status,
              )
            ) {
              startPollingRef.current?.(
                data.active_task.id,
                data.conversation.id,
                lastSeqRef.current,
              );
            }
          }
        }
      } catch {
        if (!hasCachedMessages) {
          toast.error("Failed to load conversation");
        } else {
          toast.error("Couldn't refresh conversation");
        }
      } finally {
        if (!ignore) {
          setMessagesLoading(false);
          // Mark this fast-path identity as completed only now, so a re-fire
          // caused purely by a channel-dep change is deduped (TODO 6) — while a
          // run cancelled before reaching here leaves no marker, letting the
          // successor run take over and clear the skeleton.
          markFastLoadCompleted(fastKey, fastLoadGateRef.current);
        }
      }
    }
    load();
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    agentId,
    workspaceId,
    targetConvId,
    scrollToTaskId,
    activeChannel,
    channelLoading,
  ]);

  const refreshInboxCountRef = useRef(refreshInboxCount);
  useEffect(() => {
    refreshInboxCountRef.current = refreshInboxCount;
  }, [refreshInboxCount]);

  const markedReadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversation?.id || !workspaceId) return;
    if (markedReadRef.current === conversation.id) return;
    markedReadRef.current = conversation.id;
    const timer = setTimeout(() => {
      markInboxRead(conversation.id, workspaceId)
        .then(() => refreshInboxCountRef.current())
        .catch(() => {});
    }, 1000);
    return () => {
      markedReadRef.current = null;
      clearTimeout(timer);
    };
  }, [conversation?.id, workspaceId]);

  // Scroll to bottom on initial load (skip if scroll-to-task/message is active)
  useEffect(() => {
    if (!messagesLoading && messages.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true;
      if (scrollToTaskId || scrollToMessageId) {
        isNearBottom.current = false;
      } else if (propTargetConvId) {
        setTimeout(() => {
          const assistantMsgs = scrollRef.current?.querySelectorAll(
            "[data-quote-source]",
          );
          if (assistantMsgs && assistantMsgs.length > 0) {
            const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
            lastAssistant.scrollIntoView({
              behavior: "instant",
              block: "start",
            });
          } else {
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
            });
          }
        }, 50);
      } else {
        setTimeout(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        }, 50);
      }
    }
  }, [
    messagesLoading,
    messages.length,
    scrollToTaskId,
    scrollToMessageId,
    propTargetConvId,
  ]);

  // Scroll to task when ?task= param is present
  useEffect(() => {
    if (!scrollToTaskId || messagesLoading || !conversation) return;
    isNearBottom.current = false;
    scrollTargetActiveRef.current = true;
    let cancelled = false;
    let highlightTimerId: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      if (cancelled) return false;
      const el = document.querySelector(
        `[data-task-id="${CSS.escape(scrollToTaskId)}"]`,
      );
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("task-highlight");
      highlightTimerId = setTimeout(() => {
        el.classList.remove("task-highlight");
        if (!cancelled) scrollTargetActiveRef.current = false;
      }, 1500);
      return true;
    };
    const timerId = setTimeout(async () => {
      if (cancelled) return;
      if (tryScroll()) return;
      try {
        const around = await listMessagesAroundTask(
          conversation.id,
          workspaceId,
          scrollToTaskId,
        );
        if (cancelled) return;
        if (around.length > 0) {
          setMessages((prev) => mergeMessages(prev, around));
          requestAnimationFrame(() => {
            setTimeout(() => {
              if (!tryScroll()) {
                scrollTargetActiveRef.current = false;
              }
            }, 100);
          });
        } else {
          scrollTargetActiveRef.current = false;
        }
      } catch {
        if (!cancelled) scrollTargetActiveRef.current = false;
      }
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timerId);
      if (highlightTimerId) clearTimeout(highlightTimerId);
    };
  }, [scrollToTaskId, messagesLoading, conversation, workspaceId]);

  // Scroll to message when ?msg= param is present (skip if task scroll is active)
  useEffect(() => {
    if (
      !scrollToMessageId ||
      scrollToTaskId ||
      messagesLoading ||
      !conversation
    )
      return;
    isNearBottom.current = false;
    scrollTargetActiveRef.current = true;
    let cancelled = false;
    let highlightTimerId: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      if (cancelled) return false;
      const el = document.querySelector(
        `[data-message-id="${CSS.escape(scrollToMessageId)}"]`,
      );
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("task-highlight");
      highlightTimerId = setTimeout(() => {
        el.classList.remove("task-highlight");
        if (!cancelled) scrollTargetActiveRef.current = false;
      }, 1500);
      return true;
    };
    const timerId = setTimeout(() => {
      if (cancelled) return;
      if (!tryScroll()) {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        scrollTargetActiveRef.current = false;
      }
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timerId);
      if (highlightTimerId) clearTimeout(highlightTimerId);
    };
  }, [scrollToMessageId, scrollToTaskId, messagesLoading, conversation]);

  // Auto-scroll when task badge appears or new task steps arrive
  const taskStatus = activeTask?.status;
  useEffect(() => {
    if (scrollTargetActiveRef.current) return;
    const isRunning = taskStatus === "running" || taskStatus === "queued";
    if (isRunning && isNearBottom.current) {
      scrollToBottom();
    }
  }, [taskMessages.length, taskStatus, scrollToBottom]);

  const agentName = useMemo(
    () => agents.find((a) => a.id === agentId)?.name ?? "Agent",
    [agents, agentId],
  );

  const messagesRef = useLatest(messages);
  const hasMoreRef = useLatest(hasMore);
  const prevConvsRef = useLatest(previousConversations);
  const hasMoreConvsRef = useLatest(hasMoreConversations);
  const agentNameRef = useLatest(agentName);
  const activeChannelRef = useLatest(activeChannel);

  const loadOlderMessages = useCallback(
    async (scrollToEnd = false) => {
      if (!conversation || loadingMoreRef.current) return;
      loadingMoreRef.current = true;

      const currentMessages = messagesRef.current;
      const currentHasMore = hasMoreRef.current;
      const currentHasMoreConvs = hasMoreConvsRef.current;
      const currentAgentName = agentNameRef.current;
      const currentChannel = activeChannelRef.current;
      const isSingleConvView = !!targetConvId;

      const oldest = currentMessages[0];
      const paginatingConvId =
        oldestConversationCursorRef.current?.id ?? conversation.id;
      const canLoadMoreInConv = currentHasMore && oldest;
      let prevConvsList = prevConvsRef.current;

      if (
        !isSingleConvView &&
        !canLoadMoreInConv &&
        prevConvsList.length === 0 &&
        currentHasMoreConvs
      ) {
        const oldestConv = oldestConversationCursorRef.current ?? {
          id: conversation.id,
          created_at: conversation.created_at,
        };
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

      const canLoadPrevConv = !isSingleConvView && prevConvsList.length > 0;

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
        const napMarkersToAdd: {
          agentName: string;
          created_at: string;
          id: string;
        }[] = [];

        // --- Phase 1: Load from current/paginating conversation ---
        let phase1HasMore = false;
        if (canLoadMoreInConv) {
          const cached =
            paginatingConvId === conversation.id
              ? await getCachedMessagesBefore(
                  paginatingConvId,
                  oldest!.created_at,
                  oldest!.id,
                  MESSAGE_LIMIT,
                  workspaceId,
                )
              : null;

          if (cached) {
            phase1Messages = cached.messages;
            remaining -= cached.messages.length;
            lastHasMore = cached.hasMore;
          } else {
            const result = await listMessages(paginatingConvId, workspaceId, {
              limit: MESSAGE_LIMIT,
              before: oldest!.created_at,
              beforeId: oldest!.id,
            });
            phase1Messages = result.messages;
            remaining -= result.messages.length;
            lastHasMore = result.has_more;
          }
          phase1HasMore = lastHasMore;
        }

        // --- Phase 2: Load from previous conversations (only in timeline mode) ---
        if (!isSingleConvView && !lastHasMore && remaining > 0) {
          if (prevConvsList.length === 0 && currentHasMoreConvs) {
            const oldestConv = oldestConversationCursorRef.current ?? {
              id: conversation.id,
              created_at: conversation.created_at,
            };
            try {
              const result = await listPreviousConversations(
                agentId,
                workspaceId,
                {
                  exclude: conversation.id,
                  before: oldestConv.created_at,
                  channel: currentChannel,
                },
              );
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

            const napTs =
              oldestConversationCursorRef.current?.created_at ??
              conversation.created_at;
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
                const newMarkers = napMarkersToAdd.filter(
                  (m) => !existingIds.has(m.id),
                );
                return [...prev, ...newMarkers];
              });
            }
            setHasMore(lastHasMore);
            setMessages((prev) => {
              const existingIds = new Set(prev.map((m) => m.id));
              const unique = allNewMessages.filter(
                (m) => !existingIds.has(m.id),
              );
              return [...unique, ...prev];
            });
          } else {
            setHasMore(false);
          }
        });

        if (allNewMessages.length > 0 && conversation) {
          const currentConvMessages = allNewMessages.filter(
            (m) => m.conversation_id === conversation.id,
          );
          if (currentConvMessages.length > 0) {
            mergeCachedMessages(
              conversation.id,
              currentConvMessages,
              phase1HasMore,
              workspaceId,
            ).catch(() => {});
          }
        }

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
    },
    [
      conversation,
      workspaceId,
      agentId,
      targetConvId,
      messagesRef,
      hasMoreRef,
      hasMoreConvsRef,
      agentNameRef,
      activeChannelRef,
      prevConvsRef,
    ],
  );

  const canLoadMore = targetConvId
    ? hasMore
    : hasMore || previousConversations.length > 0 || hasMoreConversations;

  useEffect(() => {
    if (conversation?.id === prevConversationIdRef.current) return;
    prevConversationIdRef.current = conversation?.id;
    backfillAttemptsRef.current = 0;
  }, [conversation?.id]);

  const MIN_MESSAGES = 10;
  useEffect(() => {
    if (messagesLoading || !conversation) return;
    if (scrollToTaskId || targetConvId) return;
    if (messages.length >= MIN_MESSAGES || !canLoadMore) return;
    if (loadingMore) return;
    if (backfillAttemptsRef.current >= 3) return;
    backfillAttemptsRef.current += 1;
    loadOlderMessages(true);
  }, [
    messagesLoading,
    messages.length,
    canLoadMore,
    loadingMore,
    conversation,
    loadOlderMessages,
    scrollToTaskId,
    targetConvId,
  ]);

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
            getTaskMessages(
              taskId,
              workspaceId,
              lastSeqRef.current || undefined,
            ),
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
              lastSeqRef.current,
            );
          }

          if (
            task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled" ||
            task.status === "superseded"
          ) {
            if (isStale) {
              // Stale poll — still merge messages but don't touch activeTask or polling
              listMessages(conversationId, workspaceId)
                .then(({ messages: latest }) => {
                  setMessages((prev) => mergeMessages(prev, latest));
                  mergeCachedMessages(
                    conversationId,
                    latest,
                    null,
                    workspaceId,
                  ).catch(() => {});
                })
                .catch(() => {});
              return;
            }

            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;

            if (markReadTimerRef.current)
              clearTimeout(markReadTimerRef.current);
            markReadTimerRef.current = setTimeout(() => {
              markInboxRead(conversationId, workspaceId)
                .then(() => refreshInboxCountRef.current())
                .catch(() => {});
            }, 1000);

            const shouldScroll =
              !scrollTargetActiveRef.current && isNearBottom.current;
            try {
              const [latestResult, arts] = await Promise.all([
                listMessages(conversationId, workspaceId),
                listArtifacts(conversationId, workspaceId).catch(() => null),
              ]);
              setMessages((prev) => mergeMessages(prev, latestResult.messages));
              mergeCachedMessages(
                conversationId,
                latestResult.messages,
                null,
                workspaceId,
              ).catch(() => {});
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
                  const { messages: latestMsgs } = await listMessages(
                    conversationId,
                    workspaceId,
                  );
                  setMessages((prev) => mergeMessages(prev, latestMsgs));
                  mergeCachedMessages(
                    conversationId,
                    latestMsgs,
                    null,
                    workspaceId,
                  ).catch(() => {});
                  setActiveTask(nextTask);
                  setTaskMessages([]);
                  startPollingRef.current?.(nextTask.id, conversationId);
                }
              } catch {}
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
    [workspaceId],
  );
  useEffect(() => {
    startPollingRef.current = startPolling;
  }, [startPolling]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    };
  }, []);

  const activeTaskIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeTaskIdRef.current = activeTask?.id ?? null;
  }, [activeTask]);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (
        msg.type === "task.messages" &&
        msg.taskId === activeTaskIdRef.current
      ) {
        const incoming = msg.messages.filter((m) => m.seq > lastSeqRef.current);
        if (incoming.length > 0) {
          setTaskMessages((prev) => {
            const existingSeqs = new Set(prev.map((m) => m.seq));
            const unique = incoming.filter((m) => !existingSeqs.has(m.seq));
            return unique.length > 0 ? [...prev, ...unique] : prev;
          });
          lastSeqRef.current = Math.max(
            ...incoming.map((m) => m.seq),
            lastSeqRef.current,
          );
        }
      }
      if (
        msg.type === "task.created" &&
        msg.conversationId === conversation?.id
      ) {
        listMessages(msg.conversationId, workspaceId)
          .then(({ messages: latest }) => {
            setMessages((prev) => mergeMessages(prev, latest));
            mergeCachedMessages(
              msg.conversationId,
              latest,
              null,
              workspaceId,
            ).catch(() => {});
          })
          .catch(() => {});
        const task = msg.task as Task;
        activeTaskIdRef.current = task.id;
        setActiveTask(task);
        setTaskMessages([]);
        lastSeqRef.current = 0;
        startPollingRef.current?.(task.id, msg.conversationId);
      }
      // Refresh the per-channel `last_open` pointer when a `task.created`
      // arrives — this is the client learning of a (possibly newer) conversation
      // for this agent+channel in real time, keeping the pointer's
      // "latest-created" semantics fresh while the user is on the page. Runs
      // independently of the active-conversation block above: a new thread spawned
      // in this channel often has a different conversationId than the one being
      // viewed, so it must NOT be gated on `msg.conversationId === conversation?.id`.
      // `activeChannelRef` is read (not `activeChannel`) because this effect does
      // not re-subscribe on channel change — the ref always holds the current value.
      if (msg.type === "task.created") {
        const task = msg.task as Task;
        const activeChannel = activeChannelRef.current;
        getLastOpenConversation(agentId, activeChannel, workspaceId)
          .then((current) => {
            const targetConvId = pointerRefreshTargetForTaskCreated({
              task,
              agentId,
              activeChannel,
              currentPointerConvId: current?.conversation_id ?? null,
            });
            if (!targetConvId) return;
            // A1: derive serverMessageCount from the locally-cached count for
            // this conversation. May under-count (e.g. brand-new thread with no
            // cache → 0), which only makes the next slow-path read fall back to
            // the skeleton (the `serverMessageCount > 0` gate) — never wrong
            // content. We never over-count, so the pointer can't claim a
            // conversation is more complete than it is.
            return getCacheMeta(targetConvId, workspaceId).then((meta) =>
              setLastOpenConversation(
                agentId,
                activeChannel,
                {
                  conversation_id: targetConvId,
                  newestMessageId: meta?.newestMessageId ?? null,
                  serverMessageCount: meta?.messageCount ?? 0,
                },
                workspaceId,
              ),
            );
          })
          .catch(() => {});
      }
      if (msg.type === "conversation.message") {
        // Only cache for the server-confirmed loaded conversation — never write
        // during the optimistic cache-first window before the id is confirmed
        // (review #1).
        if (msg.conversationId === loadConvIdRef.current) {
          appendCachedMessage(
            msg.conversationId,
            msg.message,
            workspaceId,
          ).catch(() => {});
        }
        if (msg.conversationId === conversation?.id) {
          setMessages((prev) => {
            const incomingTime = new Date(msg.message.created_at).getTime();
            const optimisticIdx = prev.findIndex(
              (m) =>
                m.id.startsWith("temp-") &&
                m.role === msg.message.role &&
                m.content === msg.message.content &&
                Math.abs(new Date(m.created_at).getTime() - incomingTime) <
                  2000,
            );
            if (optimisticIdx !== -1) {
              const updated = [...prev];
              updated[optimisticIdx] = msg.message;
              return updated;
            }
            return mergeMessages(prev, [msg.message]);
          });
        }
      }
      if (
        msg.type === "task.updated" &&
        msg.taskId === activeTaskIdRef.current
      ) {
        setActiveTask((prev) =>
          prev ? { ...prev, status: msg.status } : prev,
        );
      }
      if (
        msg.type === "artifact.uploaded" &&
        msg.conversationId === conversation?.id
      ) {
        setArtifacts((prev) => {
          if (prev.some((a) => a.id === msg.artifact.id)) return prev;
          return [...prev, msg.artifact];
        });
      }
      if (
        msg.type === "followup.dispatched" &&
        msg.conversationId === conversation?.id
      ) {
        // Optimistically remove by real ID
        setBufferedMessages((prev) =>
          prev.filter((m) => m.id !== msg.message.id),
        );
        // Always sync from server to handle temp-ID / duplicate edge cases
        listBufferedMessages(msg.conversationId, workspaceId)
          .then(setBufferedMessages)
          .catch(() => {});
        listMessages(msg.conversationId, workspaceId)
          .then(({ messages: latest }) => {
            setMessages((prev) => mergeMessages(prev, latest));
            mergeCachedMessages(
              msg.conversationId,
              latest,
              null,
              workspaceId,
            ).catch(() => {});
          })
          .catch(() => {});
        const task = msg.task as Task;
        activeTaskIdRef.current = task.id;
        setActiveTask(task);
        setTaskMessages([]);
        startPollingRef.current?.(task.id, msg.conversationId);
      }
      if (
        msg.type === "followup.created" &&
        msg.conversationId === conversation?.id
      ) {
        setBufferedMessages((prev) => addBufferedIfNew(prev, msg.message));
      }
      if (
        msg.type === "followup.deleted" &&
        msg.conversationId === conversation?.id
      ) {
        setBufferedMessages((prev) =>
          prev.filter((m) => m.id !== msg.messageId),
        );
      }
      if (
        msg.type === "followup.dispatch_failed" &&
        msg.conversationId === conversation?.id
      ) {
        toast.error(msg.error || "Failed to dispatch follow-up");
      }
    });
  }, [subscribeWs, conversation?.id, workspaceId, agentId]);

  useEffect(() => {
    return subscribeReconnect(() => {
      if (!conversation?.id) return;
      getCacheMeta(conversation.id, workspaceId).then((meta) => {
        conversationInit(conversation.id, workspaceId, {
          newestMessageId: meta?.newestMessageId ?? undefined,
          messageCount: meta?.serverMessageCount ?? undefined,
        })
          .then((data) => {
            if (!data.cache_valid && data.messages) {
              setMessages((prev) => mergeMessages(prev, data.messages!));
              writeToCacheRef
                .current(
                  data.messages,
                  data.has_more_messages,
                  data.message_count,
                )
                .catch(() => {});
            }
          })
          .catch(() => {});
      });
    });
  }, [subscribeReconnect, conversation?.id, workspaceId]);

  // Validate (10 MB cap) + stage files. Shared by the file picker, drag/drop,
  // and the composer's paste/drop handlers.
  const addPendingFiles = useCallback((files: File[]) => {
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

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList) return;
      addPendingFiles(Array.from(fileList));
      // Reset input so re-selecting the same file works
      e.target.value = "";
    },
    [addPendingFiles],
  );

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
    if (!text) {
      setSelectionPopup(null);
      return;
    }
    // Only allow quoting from assistant message bubbles
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer instanceof HTMLElement
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
    return () =>
      document.removeEventListener("selectionchange", handleTextSelect);
  }, [handleTextSelect]);

  const handleQuoteSelection = useCallback(() => {
    if (selectionPopup) {
      setQuotedText(selectionPopup.text);
      setSelectionPopup(null);
      window.getSelection()?.removeAllRanges();
      composerRef.current?.focus();
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      dragCounter.current = 0;
      addPendingFiles(Array.from(e.dataTransfer.files));
    },
    [addPendingFiles],
  );

  const handleStop = async () => {
    if (!conversation || cancelling) return;
    setCancelling(true);
    try {
      const cancelled = await cancelActiveTask(conversation.id, workspaceId);
      if (cancelled) {
        // If WS followup.dispatched already set a new active task, don't overwrite
        if (
          activeTaskIdRef.current &&
          activeTaskIdRef.current !== cancelled.id
        ) {
          return;
        }
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        const [latestResult, latestBuffered] = await Promise.all([
          listMessages(conversation.id, workspaceId),
          listBufferedMessages(conversation.id, workspaceId),
        ]);
        setMessages((prev) => mergeMessages(prev, latestResult.messages));
        mergeCachedMessages(
          conversation.id,
          latestResult.messages,
          null,
          workspaceId,
        ).catch(() => {});
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
    if ((!rawContent && pendingFiles.length === 0) || sending || !conversation)
      return;
    if (!rawContent) {
      toast.error("Please type a message");
      return;
    }

    // Prepend quoted text as blockquote if present
    let content = quotedText
      ? `> ${quotedText.split("\n").join("\n> ")}\n\n${rawContent}`
      : rawContent;

    // Prepend skill instruction if active
    if (slashCommand.activeSkill) {
      content = `/${slashCommand.activeSkill.name} ${content}`;
    }

    const filesToSend = [...pendingFiles];
    setInput("");
    setPendingFiles([]);
    setQuotedText(null);
    slashCommand.clearActiveSkill();
    setSending(true);

    const taskActive =
      !!activeTask &&
      !["completed", "failed", "cancelled", "superseded"].includes(
        activeTask.status,
      );

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
          replaceOptimisticBuffered(prev, optimisticId, message),
        );
      } catch (err) {
        setBufferedMessages((prev) =>
          prev.filter((m) => m.id !== optimisticId),
        );
        setInput(content);
        setPendingFiles(filesToSend);
        toast.error(
          err instanceof Error ? err.message : "Failed to queue follow-up",
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
      setMessages((prev) => {
        const hasOptimistic = prev.some((m) => m.id === optimistic.id);
        if (!hasOptimistic) {
          const hasReal = prev.some((m) => m.id === message.id);
          return hasReal ? prev : sortMessages([...prev, message]);
        }
        const without = prev.filter(
          (m) => m.id !== optimistic.id && m.id !== message.id,
        );
        return sortMessages([...without, message]);
      });
      appendCachedMessage(conversation.id, message, workspaceId).catch(
        () => {},
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
        err instanceof Error ? err.message : "Failed to send message",
      );
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  };

  const handleRetryTask = useCallback(async () => {
    if (!activeTask || !conversation) return;
    const newTask = await retryTask(activeTask.id, workspaceId);
    setActiveTask(newTask);
    setTaskMessages([]);
    startPolling(newTask.id, conversation.id);
  }, [activeTask, conversation, workspaceId, startPolling]);

  const handleToggleFlag = useCallback(
    async (messageId: string) => {
      const wasFlagged = flaggedIdsRef.current.has(messageId);
      setFlaggedIds((prev) => {
        const next = new Set(prev);
        if (wasFlagged) next.delete(messageId);
        else next.add(messageId);
        return next;
      });
      if (wasFlagged) {
        flagDecrement();
        apiUnflagMessage(workspaceId, messageId)
          .then(() => {
            flagRefresh();
          })
          .catch(() => {
            setFlaggedIds((prev) => new Set(prev).add(messageId));
            flagIncrement();
          });
      } else {
        flagIncrement();
        apiFlagMessage(workspaceId, messageId)
          .then(() => {
            flagRefresh();
          })
          .catch(() => {
            setFlaggedIds((prev) => {
              const next = new Set(prev);
              next.delete(messageId);
              return next;
            });
            flagDecrement();
          });
      }
    },
    [workspaceId, flagIncrement, flagDecrement, flagRefresh],
  );

  const openIssue = useCallback(
    async (issueId: string) => {
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
            .then((task) => setIssueActiveTask(task))
            .catch(() => setIssueActiveTask(null));
        }
        if (res.issue.trace_id) {
          getTrace(res.issue.trace_id, workspaceId)
            .then((t) => setIssueTraceTasks(t.tasks))
            .catch(() => setIssueTraceTasks(null));
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to load issue",
        );
        setIssueSheetOpen(false);
      } finally {
        setIssueDetailLoading(false);
      }
    },
    [workspaceId],
  );

  const issueConvId = issueDetail?.issue?.conversation_id ?? null;
  const issueTaskId = issueDetail?.issue?.latest_task_id ?? null;

  useEffect(() => {
    if (!issueSheetOpen || !selectedIssueId) return;

    return subscribeWs((msg: WsMessage) => {
      if (
        msg.type === "task.updated" &&
        issueTaskId &&
        msg.taskId === issueTaskId
      ) {
        getTask(issueTaskId, workspaceId)
          .then((task) => setIssueActiveTask(task))
          .catch(() => {});
      }
      if (
        msg.type === "conversation.message" &&
        issueConvId &&
        msg.conversationId === issueConvId
      ) {
        setIssueDetail((prev) => {
          if (!prev) return prev;
          if (prev.messages.some((m) => m.id === msg.message.id)) return prev;
          return { ...prev, messages: [...prev.messages, msg.message] };
        });
        if (
          msg.message.role === "event" &&
          msg.message.content.startsWith("Issue status changed:")
        ) {
          const match = msg.message.content.match(/-> (\w+)/);
          if (match) {
            setIssueDetail((prev) =>
              prev
                ? {
                    ...prev,
                    issue: {
                      ...prev.issue,
                      status: match[1] as Issue["status"],
                    },
                  }
                : prev,
            );
          }
        }
      }
      if (msg.type === "issue.comment" && msg.issueId === selectedIssueId) {
        setIssueDetail((prev) => {
          if (!prev) return prev;
          if (prev.comments.some((c) => c.id === msg.comment.id)) return prev;
          return { ...prev, comments: [...prev.comments, msg.comment] };
        });
      }
    });
  }, [
    issueSheetOpen,
    selectedIssueId,
    issueConvId,
    issueTaskId,
    workspaceId,
    subscribeWs,
  ]);

  const [napping, setNapping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const currentConvHasMessages = useMemo(
    () =>
      !!conversation &&
      messages.some((m) => m.conversation_id === conversation.id),
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
      const newConv = await createConversation(
        agentId,
        workspaceId,
        activeChannel,
      );

      setNapMarkers((prev) => [
        ...prev,
        {
          agentName,
          created_at: newConv.created_at,
          id: `nap-${conversation.id}`,
        },
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

  const isTaskActive =
    !!activeTask &&
    !["completed", "failed", "cancelled", "superseded"].includes(
      activeTask.status,
    );

  if (messagesLoading) {
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
        {/* Skeleton input area — mirrors the real rounded pill */}
        <div className="px-3 md:px-5 pt-3 pb-5 md:pb-6">
          <div className="mx-auto max-w-2xl">
            <Skeleton className="h-12 w-full rounded-3xl" />
          </div>
        </div>
      </>
    );
  }

  if (!messagesLoading && !conversation && messages.length === 0) {
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
          style={{
            left: selectionPopup.x,
            top: selectionPopup.y,
            transform: "translate(-100%, -100%)",
          }}
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
              '[data-streamdown="code-block-actions"] button',
            );
            if (btn) toast.success("Copied to clipboard");
          }}
        >
          <div className="mx-auto max-w-2xl pt-6 pb-15 min-w-0">
            {conversation && canLoadMore && !loadingMore && (
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

            {messages.length === 0 &&
              !activeTask &&
              (() => {
                const agent = agents.find((a) => a.id === agentId);
                const isNewAgent =
                  agent?.created_at &&
                  renderNow - new Date(agent.created_at).getTime() <
                    5 * 60 * 1000;
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
                        Wait for the email task in the top-left to complete,
                        then check your inbox. Or send a message below to start
                        chatting.
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

            {timeline.map((item, idx) => {
              const pos = groupPositions[idx];
              const isGroupStart =
                pos === "first" || pos === "solo" || pos === null;
              const spacing = idx === 0 ? "" : isGroupStart ? "mt-4" : "mt-0.5";

              if (item.kind === "nap") {
                return (
                  <div key={item.data.id} className={spacing}>
                    <NapSeparator agentName={agentName} />
                  </div>
                );
              }

              if (item.kind === "artifact") {
                return (
                  <div key={`artifact-${item.data.id}`} className={spacing}>
                    <ArtifactCard
                      artifact={item.data}
                      version={versionMap.get(item.data.id) ?? 1}
                      hasDuplicates={duplicateFilenames.has(item.data.filename)}
                      onClick={handleArtifactClick}
                    />
                  </div>
                );
              }

              const msg = item.data;
              return (
                <div key={msg.id} className={spacing}>
                  <MessageItem
                    msg={msg}
                    agents={agents}
                    artifacts={artifacts}
                    activeTask={activeTask}
                    taskMessages={taskMessages}
                    connectionLost={connectionLost}
                    isLastMessage={
                      messages.length > 0 &&
                      messages[messages.length - 1].id === msg.id
                    }
                    thinkingCount={
                      msg.task_id ? (thinkingCounts[msg.task_id] ?? 0) : 0
                    }
                    targetConvId={targetConvId}
                    workspaceId={workspaceId}
                    conversationType={conversation?.type}
                    pendingFilesByMessage={pendingFilesByMessage}
                    onArtifactClick={handleArtifactClick}
                    onEmailClick={(emailId) => {
                      setSelectedEmailId(emailId);
                      setEmailSheetOpen(true);
                    }}
                    onCalendarEventClick={(id) => {
                      setSelectedCalendarEventId(id);
                      setCalendarEventSheetOpen(true);
                    }}
                    onIssueClick={(issueId) => openIssue(issueId)}
                    onRetry={handleRetryTask}
                    mentionComponents={MENTION_COMPONENTS}
                    isFlagged={flaggedIds.has(msg.id)}
                    onToggleFlag={
                      msg.role === "assistant" ? handleToggleFlag : undefined
                    }
                    groupPosition={pos ?? "solo"}
                  />
                </div>
              );
            })}

            {/* Show trace while task is in progress (no assistant message yet) */}
            {activeTask &&
              activeTask.conversation_id === conversation?.id &&
              !["completed", "failed", "cancelled", "superseded"].includes(
                activeTask.status,
              ) && (
                <div className="mt-4">
                  <TaskStream
                    task={activeTask}
                    messages={taskMessages}
                    connectionLost={connectionLost}
                  />
                </div>
              )}
          </div>
        </div>
        <ScrollToBottomButton scrollRef={scrollRef} />
      </div>

      {/* Follow-up buffer indicator */}
      {conversation && (
        <FollowUpBuffer
          bufferedMessages={bufferedMessages}
          onDelete={(messageId) => {
            const prev = bufferedMessages;
            setBufferedMessages((cur) => cur.filter((m) => m.id !== messageId));
            deleteBufferedMessage(
              conversation.id,
              messageId,
              workspaceId,
            ).catch(() => {
              setBufferedMessages(prev);
              toast.error("Failed to delete follow-up");
            });
          }}
        />
      )}

      {/* Input */}
      <div className="relative z-10 px-3 md:px-5 pt-3 pb-5 md:pb-6">
        <div className="mx-auto max-w-2xl relative">
          <div className="flex items-end gap-2">
            {/* Overflow menu */}
            {!targetConvId && (
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 self-end mb-2.5 size-8 rounded-full text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                    />
                  }
                >
                  <MoreHorizontal className="size-4" />
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-auto p-1.5 flex flex-col gap-0.5"
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={(props) => (
                        <span
                          {...props}
                          className={cn("inline-flex", props.className)}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setMenuOpen(false);
                              handleNap();
                            }}
                            disabled={
                              napping ||
                              !conversation ||
                              !currentConvHasMessages ||
                              isTaskActive
                            }
                            className="w-full justify-start gap-2 rounded-md text-muted-foreground hover:text-foreground"
                          >
                            {napping ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <BedDouble className="size-3.5" />
                            )}
                            <span className="text-xs">Nap</span>
                          </Button>
                        </span>
                      )}
                    />
                    <TooltipContent side="right">
                      {isTaskActive
                        ? "Wait for the task to finish"
                        : currentConvHasMessages
                          ? "Take a nap"
                          : `${agentName} is well-rested and ready to go`}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMenuOpen(false);
                      setArtifactSheetSource("agent");
                      setArtifactSheetOpen(true);
                    }}
                    className="relative w-full justify-start gap-2 rounded-md text-muted-foreground hover:text-foreground"
                  >
                    <Box className="size-3.5" />
                    <span className="text-xs">Artifacts</span>
                    {agentArtifacts.length > 0 && (
                      <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-medium text-primary-foreground">
                        {agentArtifacts.length}
                      </span>
                    )}
                  </Button>
                </PopoverContent>
              </Popover>
            )}

            {/* Pill container */}
            <div
              className={cn(
                "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border/50 bg-background/90 transition-[border-radius] duration-200",
                "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
                (isMultiLine || quotedText || slashCommand.activeSkill) &&
                  "rounded-2xl",
                sending && "opacity-50",
                dragging && "border-ring ring-3 ring-ring/50",
              )}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            >
              {dragging && (
                <div
                  className={cn(
                    "absolute inset-0 z-10 flex items-center justify-center bg-background/80 border-2 border-dashed border-ring pointer-events-none",
                    isMultiLine || quotedText || slashCommand.activeSkill
                      ? "rounded-2xl"
                      : "rounded-3xl",
                  )}
                >
                  <p className="text-sm text-muted-foreground font-medium">
                    Drop files here
                  </p>
                </div>
              )}
              {slashCommand.activeSkill && (
                <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1 border-b border-border/50">
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="shrink-0 text-xs font-medium text-primary">
                      /{slashCommand.activeSkill.name}
                    </span>
                    {slashCommand.activeSkill.isGlobal && (
                      <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded px-1 py-0.5">
                        Global
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground truncate">
                      {slashCommand.activeSkill.description}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={slashCommand.clearActiveSkill}
                    className="shrink-0 p-0.5 rounded-sm hover:bg-muted-foreground/20 transition-colors text-muted-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {quotedText && (
                <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1 border-b border-border/50">
                  <div className="flex-1 min-w-0 flex items-start gap-2">
                    <MessageSquareQuote className="size-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground truncate">
                      {quotedText.slice(0, 120)}
                      {quotedText.length > 120 ? "..." : ""}
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
              <SlashCommandPopup
                isOpen={slashCommand.isOpen}
                skills={slashCommand.skills}
                selectedIndex={slashCommand.selectedIndex}
                onSelect={slashCommand.selectSkill}
                anchorPos={slashCommand.anchorPos}
              />
              {/* Pending file pills — above the input text, never disturbs the buttons */}
              {pendingFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3.5 pt-3 pb-0.5">
                  {pendingFiles.map((file, i) => (
                    <span
                      key={`${file.name}-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                    >
                      <FileText className="size-3 shrink-0" />
                      <span className="truncate max-w-30">{file.name}</span>
                      <span className="text-muted-foreground/60">
                        {formatSize(file.size)}
                      </span>
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
              {/* Composer + absolutely-positioned buttons */}
              <div className="relative">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                {/* Padding wrapper: vertical breathing room lives here so it
                    survives editor scrolling — the .tiptap element owns no padding. */}
                <div className="px-13 py-3">
                  <ChatComposer
                    ref={composerRef}
                    value={input}
                    onChange={setInput}
                    onEditorState={(text, caret) => {
                      setEditorText(text);
                      setCaretIndex(caret);
                    }}
                    onSend={handleSend}
                    placeholder={
                      isTaskActive ? "Type a follow-up..." : "Type a task..."
                    }
                    disabled={sending}
                    onMultiLineChange={setIsMultiLine}
                    onFiles={addPendingFiles}
                    agents={otherAgents}
                    agentLinks={agentLinks}
                    currentAgentId={agentId}
                    slashIsOpen={slashCommand.isOpen}
                    onSlashKeyDown={slashCommand.handleSlashKeyDown}
                  />
                </div>
                {/* Attach button — fixed bottom-left */}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => fileInputRef.current?.click()}
                        disabled={sending}
                        className="absolute left-2 bottom-2 size-8 rounded-full text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                      />
                    }
                  >
                    <Paperclip className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent side="top">Attach files</TooltipContent>
                </Tooltip>
                {/* Send / Stop button — fixed bottom-right */}
                {isTaskActive && !input.trim() && !sending ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          onClick={handleStop}
                          disabled={cancelling}
                          className="absolute right-2 bottom-2 size-8 rounded-full bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors duration-200"
                        />
                      }
                    >
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
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          onClick={handleSend}
                          disabled={!input.trim() || sending}
                          className={cn(
                            "absolute right-2 bottom-2 size-8 rounded-full bg-primary text-primary-foreground transition-opacity duration-200",
                            !input.trim() && "opacity-30",
                          )}
                        />
                      }
                    >
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
            {/* Symmetric spacer: balances the leading overflow button so the
                pill stays horizontally centered under the messages column. */}
            {!targetConvId && (
              <div className="shrink-0 self-end mb-2.5 size-8" aria-hidden="true" />
            )}
          </div>
        </div>
      </div>

      <ArtifactSheet
        open={artifactSheetOpen}
        onOpenChange={(v) => {
          setArtifactSheetOpen(v);
          if (!v)
            setTimeout(() => {
              setSelectedArtifact(null);
              setArtifactSheetSource(null);
            }, 300);
        }}
        artifacts={artifactSheetArtifacts}
        workspaceId={workspaceId}
        initialArtifact={selectedArtifact}
        versionMap={artifactSheetVersionMap}
        duplicateFilenames={artifactSheetDuplicateFilenames}
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

      <CalendarEventSheet
        readonly
        open={calendarEventSheetOpen}
        onOpenChange={(v) => {
          setCalendarEventSheetOpen(v);
          if (!v) setTimeout(() => setSelectedCalendarEventId(null), 300);
        }}
        calendarEventId={selectedCalendarEventId}
        workspaceId={workspaceId}
      />

      <IssueSheet
        open={issueSheetOpen}
        onOpenChange={(v) => {
          setIssueSheetOpen(v);
          if (!v)
            setTimeout(() => {
              setSelectedIssueId(null);
              setIssueDetail(null);
              setIssueActiveTask(null);
            }, 300);
        }}
        agents={agents}
        issue={issueDetail?.issue ?? null}
        detail={
          issueDetail
            ? {
                messages: issueDetail.messages,
                comments: issueDetail.comments,
                artifacts: issueDetail.artifacts,
                traceId: issueDetail.issue.trace_id,
              }
            : null
        }
        detailLoading={issueDetailLoading}
        activeTask={issueActiveTask}
        traceTasks={issueTraceTasks}
        slug={slug}
        workspaceId={workspaceId}
        onUpdate={async (issueId, patch) => {
          try {
            const updated = await updateIssue(workspaceId, issueId, patch);
            setIssueDetail((prev) =>
              prev && prev.issue.id === issueId
                ? {
                    ...prev,
                    issue: {
                      ...prev.issue,
                      ...patch,
                      updated_at: updated.updated_at,
                    },
                  }
                : prev,
            );
          } catch (err) {
            toast.error(
              err instanceof Error ? err.message : "Failed to update issue",
            );
          }
        }}
        onStatusChange={async (issueId, status) => {
          try {
            await updateIssue(workspaceId, issueId, {
              status: status as Issue["status"],
            });
            setIssueDetail((prev) =>
              prev && prev.issue.id === issueId
                ? {
                    ...prev,
                    issue: { ...prev.issue, status: status as Issue["status"] },
                  }
                : prev,
            );
          } catch (err) {
            toast.error(
              err instanceof Error ? err.message : "Failed to update status",
            );
          }
        }}
        onCommented={() => {
          if (selectedIssueId) openIssue(selectedIssueId);
        }}
        onArtifactClick={handleIssueArtifactClick}
      />
    </>
  );
}
