"use client";

import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { TaskStream } from "@/components/task-stream";
import {
  getTask,
  updateIssue,
  getAgentSkills,
  cancelActiveTask,
  getThreadSummaries,
  createThread,
  conversationInit,
} from "@/lib/api";
import { useLatest } from "@/components/agent-chat/chat-message-utils";
import type {
  Artifact,
  Issue,
  Message,
  SkillEntry,
  WsMessage,
} from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { useInboxCount } from "@/contexts/inbox-count-context";
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
  FileText,
  Loader2,
  Mail,
  MessageSquareQuote,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { useAgentChat } from "@/hooks/use-agent-chat";
import { useMessageFlags } from "@/hooks/use-message-flags";
import { useChatSheets } from "@/hooks/use-chat-sheets";
import { useFileAttachments } from "@/hooks/use-file-attachments";
import { useTextSelectionQuote } from "@/hooks/use-text-selection-quote";
import { useSlashCommand } from "@/hooks/use-slash-command";
import { SlashCommandPopup } from "@/components/agent-chat/slash-command-popup";
import {
  ChatComposer,
  RotatingPlaceholderOverlay,
} from "@/components/agent-chat/chat-composer";
import { useRotatingPlaceholder } from "@/components/agent-chat/use-rotating-placeholder";
import {
  ArtifactSheet,
  formatSize,
} from "@/components/agent-chat/artifact-sheet";
import { EmailEventSheet } from "@/components/agent-chat/email-event-sheet";
import { ImageLightbox } from "@/components/agent-chat/image-lightbox";
import { CalendarEventSheet } from "@/components/calendar/calendar-event-sheet";
import { IssueSheet } from "@/components/issues/issue-sheet";
import {
  isPreviewable,
  getArtifactUrl,
  computeArtifactVersions,
} from "@/components/artifact-content-renderer";
import { ScrollToBottomButton } from "@/components/ui/scroll-to-bottom-button";
import { MessageItem, AgentRow } from "@/components/agent-chat/message-list";
import { useAgentChatSheet } from "@/contexts/agent-chat-sheet-context";
import { PresenceLine } from "@/components/agent-chat/presence-line";
import { MenuToggleIcon } from "@/components/agent-chat/menu-toggle-icon";
import { parseAvatarUrl } from "@/components/avatar";
import {
  MENTION_COMPONENTS,
  NapSeparator,
  ArtifactCard,
} from "@/components/agent-chat/chat-view-parts";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";

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
    runtimes,
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
  // Resolve the conversation agent's runtime provider so runtime errors can be
  // attributed to the runtime CLI (Claude Code / Codex / OpenCode) — issue #236.
  const activeAgent = agents.find((a) => a.id === agentId);
  const activeRuntime = activeAgent?.runtime_id
    ? runtimes.find((r) => r.id === activeAgent.runtime_id)
    : null;
  const runtimeProvider = activeRuntime?.provider ?? null;
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

  const [input, setInput] = useState(() => {
    if (typeof window === "undefined") return "";
    return (
      localStorage.getItem(
        `chat-draft:${agentId}:${targetConvId ?? "default"}`,
      ) ?? ""
    );
  });
  const [composerFocused, setComposerFocused] = useState(false);
  const {
    artifactSheetOpen,
    setArtifactSheetOpen,
    selectedArtifact,
    setSelectedArtifact,
    emailSheetOpen,
    setEmailSheetOpen,
    selectedEmailId,
    setSelectedEmailId,
    calendarEventSheetOpen,
    setCalendarEventSheetOpen,
    selectedCalendarEventId,
    setSelectedCalendarEventId,
    issueSheetOpen,
    setIssueSheetOpen,
    selectedIssueId,
    setSelectedIssueId,
    issueDetail,
    setIssueDetail,
    issueDetailLoading,
    issueTraceTasks,
    issueActiveTask,
    setIssueActiveTask,
    openIssue,
    issueConvId,
    issueTaskId,
  } = useChatSheets(workspaceId);
  const [lightboxArtifact, setLightboxArtifact] = useState<Artifact | null>(null);
  const [lightboxLocalUrl, setLightboxLocalUrl] = useState<{ url: string; filename: string } | null>(null);
  const {
    pendingFiles,
    setPendingFiles,
    fileInputRef,
    addPendingFiles,
    handleFileSelect,
    removePendingFile,
    dragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useFileAttachments();
  const [caretIndex, setCaretIndex] = useState<number | null>(null);
  const [renderNow] = useState(() => Date.now());

  const [quotedMessage, setQuotedMessage] = useState<{ id: string; excerpt: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const meta = JSON.parse(
        localStorage.getItem(
          `chat-draft-meta:${agentId}:${targetConvId ?? "default"}`,
        ) ?? "null",
      );
      const q = meta?.quote;
      return q && typeof q === "object" && q.id ? q : null;
    } catch {
      return null;
    }
  });
  const [isMultiLine, setIsMultiLine] = useState(false);
  const { flaggedIds, setFlaggedIds, handleToggleFlag } =
    useMessageFlags(workspaceId);

  // Thread state
  const { openAgentChat } = useAgentChatSheet();
  const [threadSummaries, setThreadSummaries] = useState<Map<string, { thread_id: string; reply_count: number; last_reply_at: string | null; thread_title: string }>>(new Map());
  const [threadRootMessage, setThreadRootMessage] = useState<Message | null>(null);

  useEffect(() => {
    setChannelAgentId(agentId);
  }, [agentId, setChannelAgentId]);

  // Component-owned ref written by the hook's load effect; read by the
  // draft-meta persist effect below to gate the first write until restore runs.
  const draftMetaRestoredRef = useRef(false);

  // Reader-refs for the externally-owned values the orchestration reads inside
  // long-lived callbacks (handleSend). useLatest keeps them fresh without
  // churning callback identity. `activeSkillRef` is a manual ref synced below,
  // because `slashCommand` is defined after `useAgentChat` (it needs the
  // hook-created `composerRef`).
  const inputRef = useLatest(input);
  const quotedMessageRef = useLatest(quotedMessage);
  const pendingFilesRef = useLatest(pendingFiles);
  const activeSkillRef = useRef<SkillEntry | null>(null);
  // Holds the `slashCommand` instance (created after this hook call, since it
  // needs the hook's `composerRef`) so the hook's setActiveSkill/clearActiveSkill
  // wrappers can reach it from inside the load effect.
  const slashCommandRef = useRef<ReturnType<typeof useSlashCommand> | null>(
    null,
  );

  const chat = useAgentChat(
    {
      agentId,
      targetConvId,
      scrollToTaskId,
      scrollToMessageId,
      propTargetConvId,
      workspaceId,
      agents,
      activeChannel,
      channelLoading,
      subscribeWs,
      subscribeReconnect,
      refreshInboxCount,
    },
    {
      setFlaggedIds,
      setPendingFiles,
      setInput,
      setQuotedMessage,
      setActiveSkill: (skill: SkillEntry | null) =>
        slashCommandRef.current?.setActiveSkill(skill),
      clearActiveSkill: () => slashCommandRef.current?.clearActiveSkill(),
      inputRef,
      quotedMessageRef,
      pendingFilesRef,
      activeSkillRef,
      draftMetaRestoredRef,
    },
  );

  const {
    conversation,
    messages,
    sending,
    activeTask,
    taskMessages,
    messagesLoading,
    connectionLost,
    loadingMore,
    artifacts,
    napping,
    pendingFilesByMessage,
    failedSends,
    stableKeyMap,
    agentArtifacts,
    agentName,
    timeline,
    groupPositions,
    activeTaskStreamMsgId,
    canLoadMore,
    currentConvHasMessages,
    scrollRef,
    composerRef,
    loadOlderMessages,
    handleScroll,
    handleSend,
    handleRetrySend,
    handleRetryTask,
    handleNap,
  } = chat;

  const { versionMap, duplicateFilenames } = useMemo(
    () => computeArtifactVersions(agentArtifacts),
    [agentArtifacts],
  );

  // Fetch root message for thread conversations
  useEffect(() => {
    if (!conversation?.parent_message_id || !workspaceId) {
      setThreadRootMessage(null);
      return;
    }
    conversationInit(conversation.id, workspaceId)
      .then((data) => {
        if (data.root_message) setThreadRootMessage(data.root_message);
      })
      .catch(() => {});
  }, [conversation?.id, conversation?.parent_message_id, workspaceId]);

  const fetchThreadSummaries = useCallback(() => {
    if (!conversation?.id || !workspaceId) return;
    getThreadSummaries(conversation.id, workspaceId)
      .then((data) => {
        const map = new Map<string, { thread_id: string; reply_count: number; last_reply_at: string | null; thread_title: string }>();
        for (const s of data.thread_summaries) {
          map.set(s.parent_message_id, {
            thread_id: s.thread_id,
            reply_count: s.reply_count,
            last_reply_at: s.last_reply_at,
            thread_title: s.thread_title,
          });
        }
        setThreadSummaries(map);
      })
      .catch(() => {});
  }, [conversation?.id, workspaceId]);

  useEffect(() => { fetchThreadSummaries(); }, [fetchThreadSummaries]);

  useEffect(() => {
    return subscribeWs((msg: WsMessage) => {
      if (msg.type === "thread.created" || msg.type === "thread.reply") {
        fetchThreadSummaries();
      }
    });
  }, [subscribeWs, fetchThreadSummaries]);

  const agentAvatarConfig = useMemo(
    () => parseAvatarUrl(agents.find((a) => a.id === agentId)?.avatar_url ?? null),
    [agents, agentId],
  );
  // First name only — presence copy reads socially ("Maya is typing…").
  const agentFirstName = useMemo(() => agentName.split(/\s+/)[0] || agentName, [agentName]);

  const handlePendingImageClick = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      setLightboxLocalUrl({ url, filename: file.name });
    },
    [],
  );

  const handleArtifactClick = useCallback(
    (artifact: Artifact) => {
      if (artifact.content_type.startsWith("image/")) {
        setLightboxArtifact(artifact);
      } else if (isPreviewable(artifact)) {
        setSelectedArtifact(artifact);
        setArtifactSheetOpen(true);
      } else {
        window.open(getArtifactUrl(artifact.id, workspaceId, true), "_blank");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setState fns are stable
    [workspaceId],
  );

  const handleIssueArtifactClick = useCallback(
    (artifact: Artifact) => {
      if (artifact.content_type.startsWith("image/")) {
        setLightboxArtifact(artifact);
      } else if (isPreviewable(artifact)) {
        setSelectedArtifact(artifact);
        setArtifactSheetOpen(true);
      } else {
        window.open(getArtifactUrl(artifact.id, workspaceId, true), "_blank");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setState fns are stable
    [workspaceId],
  );

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

  useEffect(() => {
    if (skillsFetchedRef.current) return;
    skillsFetchedRef.current = true;
    getAgentSkills(agentId, workspaceId)
      .then((res) => setAgentSkills(res.skills as SkillEntry[]))
      .catch(() => { });
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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- composerRef is stable
      [],
    ),
    onAfterSelect: useCallback(() => {
      requestAnimationFrame(() => composerRef.current?.focus());
      // eslint-disable-next-line react-hooks/exhaustive-deps -- composerRef is stable
    }, []),
  });

  // Bridge `slashCommand` (defined here, after `useAgentChat` because it needs
  // the hook-created `composerRef`) back to the orchestration: a ref the hook's
  // setActiveSkill/clearActiveSkill wrappers call, and a useLatest-style sync of
  // `activeSkill` into the `activeSkillRef` the hook reads inside handleSend.
  // MUST be a layout effect, not a passive one: the hook's load effect (passive)
  // runs on first mount and calls setActiveSkill to restore a saved skill draft.
  // React fires all layout effects of a commit before any passive effect, so this
  // populates slashCommandRef before the load effect reads it — a passive sync
  // here would still be null then and silently drop the restore.
  useLayoutEffect(() => {
    slashCommandRef.current = slashCommand;
    activeSkillRef.current = slashCommand.activeSkill;
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
      quote?: { id: string; excerpt: string } | null;
    } = {};
    if (slashCommand.activeSkill) {
      meta.skill = {
        name: slashCommand.activeSkill.name,
        description: slashCommand.activeSkill.description,
      };
    }
    if (quotedMessage) {
      meta.quote = quotedMessage;
    }
    if (meta.skill || meta.quote) {
      localStorage.setItem(key, JSON.stringify(meta));
    } else {
      localStorage.removeItem(key);
    }
  }, [slashCommand.activeSkill, quotedMessage, agentId, targetConvId]);

  useEffect(() => {
    if (!sending) {
      composerRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composerRef is stable
  }, [sending]);


  const { selectionPopup, setSelectionPopup } = useTextSelectionQuote();

  const handleQuoteSelection = useCallback(() => {
    if (selectionPopup) {
      const excerpt = selectionPopup.text.slice(0, 100);
      setQuotedMessage(
        selectionPopup.messageId
          ? { id: selectionPopup.messageId, excerpt }
          : null,
      );
      setSelectionPopup(null);
      window.getSelection()?.removeAllRanges();
      composerRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composerRef and setSelectionPopup are stable
  }, [selectionPopup]);

  const handleQuoteMessage = useCallback((messageId: string, excerpt: string) => {
    setQuotedMessage({ id: messageId, excerpt });
    composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- composerRef is stable
  }, []);

  const handleEmailClick = useCallback((emailId: string) => {
    setSelectedEmailId(emailId);
    setEmailSheetOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setState fns are stable
  }, []);

  const handleCalendarEventClick = useCallback((id: string) => {
    setSelectedCalendarEventId(id);
    setCalendarEventSheetOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setState fns are stable
  }, []);

  const handleIssueClick = useCallback((issueId: string) => {
    openIssue(issueId);
  }, [openIssue]);

  const handleAgentChatOpen = useCallback((agId: string, convId: string) => {
    openAgentChat(agId, { conversationId: convId });
  }, [openAgentChat]);

  const threadSummariesRef = useLatest(threadSummaries);
  const conversationRef = useLatest(conversation);
  const fetchThreadSummariesRef = useLatest(fetchThreadSummaries);

  const handleReplyInThread = useCallback(async (msgId: string) => {
    const summary = threadSummariesRef.current.get(msgId);
    if (summary?.thread_id) {
      openAgentChat(agentId, { conversationId: summary.thread_id });
    } else if (conversationRef.current) {
      try {
        const result = await createThread(conversationRef.current.id, msgId, "", workspaceId);
        openAgentChat(agentId, { conversationId: result.conversation.id });
        fetchThreadSummariesRef.current();
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  }, [openAgentChat, agentId, workspaceId]);

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
          .catch(() => { });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setState fns are stable
  }, [
    issueSheetOpen,
    selectedIssueId,
    issueConvId,
    issueTaskId,
    workspaceId,
    subscribeWs,
  ]);

  const [menuOpen, setMenuOpen] = useState(false);
  const [stopping, setStopping] = useState(false);

  const isTaskActive =
    !!activeTask &&
    !["completed", "failed", "cancelled", "superseded"].includes(
      activeTask.status,
    );

  const handleStop = useCallback(async () => {
    if (!conversation?.id || stopping) return;
    setStopping(true);
    try {
      await cancelActiveTask(conversation.id, workspaceId);
    } catch {
      toast.error("Failed to stop the task");
    } finally {
      setStopping(false);
    }
  }, [conversation?.id, workspaceId, stopping]);

  // Rotating capability-hint placeholder for the idle, empty composer. Freezes
  // on focus/typing, resumes on empty blur; never rotates while a task is
  // active (that path shows the static "Message {Name}" overlay below instead).
  const rotatingPlaceholder = useRotatingPlaceholder({
    isEmpty: input.trim() === "",
    isFocused: composerFocused,
    isTaskActive,
  });

  if (messagesLoading) {
    return (
      <>
        <div className="flex-1 overflow-y-auto px-3 sm:px-4">
          <div className="mx-auto max-w-3xl py-6 space-y-6 motion-safe:animate-[fade-up_200ms_ease-out_both]">
            {/* Agent cluster — top [avatar][name] header, bubbles stacked below
                in the gutter (mirrors AgentRow's Slack/Discord layout). */}
            <div className="flex justify-start items-start gap-2">
              <Skeleton className="size-7.5 shrink-0 rounded-md" />
              <div className="flex flex-col items-start gap-1 max-w-[86%]">
                <Skeleton className="h-3 w-20 rounded mb-1" />
                <Skeleton className="h-9 w-64 rounded-[1.05rem]" />
                <Skeleton className="h-9 w-48 rounded-[1.05rem]" />
              </div>
            </div>
            {/* User cluster — right pills, no avatar/name */}
            <div className="flex flex-col items-end gap-1">
              <Skeleton className="h-9 w-44 rounded-[1.05rem]" />
              <Skeleton className="h-9 w-32 rounded-[1.05rem]" />
            </div>
            {/* Another agent cluster */}
            <div className="flex justify-start items-start gap-2">
              <Skeleton className="size-7.5 shrink-0 rounded-md" />
              <div className="flex flex-col items-start gap-1 max-w-[86%]">
                <Skeleton className="h-3 w-20 rounded mb-1" />
                <Skeleton className="h-9 w-56 rounded-[1.05rem]" />
              </div>
            </div>
          </div>
        </div>
        {/* Presence line + input — mirror the real layout exactly so nothing
            shifts on load: presence row (h-5 + mb-2) above, then the composer
            row of [overflow button][pill][symmetric spacer]. */}
        <div data-keyboard-offset className="relative z-10 px-3 sm:px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-6">
          <div className="mx-auto max-w-3xl">
            <div className="h-5 px-1 mb-2 flex items-center">
              <Skeleton className="h-3.5 w-28 rounded" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <Skeleton className="h-10 flex-1 rounded-3xl" />
            </div>
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
          className="h-full overflow-y-auto overflow-x-hidden px-3 sm:px-4 thin-scrollbar"
          ref={scrollRef}
          onScroll={handleScroll}
          onClick={(e) => {
            const btn = (e.target as HTMLElement).closest(
              '[data-streamdown="code-block-actions"] button',
            );
            if (btn) toast.success("Copied to clipboard");
          }}
        >
          <div className="mx-auto max-w-3xl pt-6 pb-15 min-w-0">
            {/* Root message for thread conversations — rendered as a normal MessageItem with flagged emphasis + corner icon, no actions */}
            {threadRootMessage && (
              <div className="mb-2">
                <MessageItem
                  msg={threadRootMessage}
                  agents={agents}
                  artifacts={[]}
                  activeTask={null}
                  taskMessages={[]}
                  connectionLost={false}
                  pendingFilesByMessage={new Map()}
                  workspaceId={workspaceId}
                  onArtifactClick={() => {}}
                  onEmailClick={() => {}}
                  onIssueClick={() => {}}
                  onCalendarEventClick={() => {}}
                  mentionComponents={MENTION_COMPONENTS}
                  groupPosition="solo"
                  agentName={agentName}
                  agentAvatarConfig={agentAvatarConfig}
                  isThreadRoot
                />
              </div>
            )}
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
                  <p className="text-center text-muted-foreground py-20 text-base animate-[fade-up_400ms_ease-out_both]">
                    Say hi to {agentFirstName}.
                  </p>
                );
              })()}

            {timeline.map((item, idx) => {
              const pos = groupPositions[idx];
              const isGroupStart =
                pos === "first" || pos === "solo" || pos === null;
              // mt-6 between clusters, mt-2 between grouped bubbles within a cluster.
              const spacing = idx === 0 ? "" : isGroupStart ? "mt-6" : "mt-2";

              if (item.kind === "nap") {
                return (
                  <div key={item.data.id} className={spacing}>
                    <NapSeparator agentName={agentName} />
                  </div>
                );
              }

              if (item.kind === "artifact") {
                // A file card is part of the agent's cluster (computeGroupPositions
                // groups it with adjacent agent items). It shows the avatar + name
                // only when it's the cluster HEAD (first/solo) — e.g. a file
                // uploaded mid-task before any reply exists; otherwise a spacer, so
                // it never renders as an orphaned, avatar-less "empty file" state.
                const artifactPos = pos ?? "solo";
                const isHead = artifactPos === "first" || artifactPos === "solo";
                return (
                  <div key={`artifact-${item.data.id}`} className={spacing}>
                    <AgentRow
                      groupPosition={artifactPos}
                      agentName={agentName}
                      config={agentAvatarConfig}
                      forceSpacer={!isHead}
                    >
                      <ArtifactCard
                        artifact={item.data}
                        version={versionMap.get(item.data.id) ?? 1}
                        hasDuplicates={duplicateFilenames.has(item.data.filename)}
                        onClick={handleArtifactClick}
                        workspaceId={workspaceId}
                      />
                    </AgentRow>
                  </div>
                );
              }

              const msg = item.data;
              // Use the original optimistic ID as the React key when available,
              // so replacing "temp-xxx" → "msg_abc" is an in-place UPDATE (same
              // key, new props) instead of an unmount+remount — eliminating the
              // visual flicker that occurred when the entire message row was torn
              // down and rebuilt with a different key.
              const stableKey = stableKeyMap.get(msg.id) ?? msg.id;
              return (
                <div key={stableKey} className={spacing}>
                  <MessageItem
                    msg={msg}
                    agents={agents}
                    artifacts={artifacts}
                    activeTask={activeTask}
                    activeTaskStreamMsgId={activeTaskStreamMsgId}
                    taskMessages={taskMessages}
                    connectionLost={connectionLost}
                    conversationType={conversation?.type}
                    pendingFilesByMessage={pendingFilesByMessage}
                    workspaceId={workspaceId}
                    onArtifactClick={handleArtifactClick}
                    onPendingImageClick={handlePendingImageClick}
                    onEmailClick={handleEmailClick}
                    onCalendarEventClick={handleCalendarEventClick}
                    onIssueClick={handleIssueClick}
                    onRetry={handleRetryTask}
                    mentionComponents={MENTION_COMPONENTS}
                    isFlagged={flaggedIds.has(msg.id)}
                    onToggleFlag={
                      msg.role === "assistant" ? handleToggleFlag : undefined
                    }
                    groupPosition={pos ?? "solo"}
                    provider={runtimeProvider}
                    agentName={agentName}
                    agentAvatarConfig={agentAvatarConfig}
                    isSendFailed={failedSends.has(msg.id)}
                    onRetrySend={handleRetrySend}
                    onQuote={handleQuoteMessage}
                    onReplyInThread={conversation?.parent_message_id ? undefined : handleReplyInThread}
                    threadSummary={conversation?.parent_message_id ? null : threadSummaries.get(msg.id) ?? null}
                    onAgentChatOpen={handleAgentChatOpen}
                  />
                </div>
              );
            })}

            {/* Show trace while task is in progress (no assistant message yet).
                Once a send-dm reply exists, the designated last message
                (activeTaskStreamMsgId) owns the error surface — suppress this
                standalone block then, so an error never renders twice (QA AC4). */}
            {activeTask &&
              activeTask.conversation_id === conversation?.id &&
              activeTaskStreamMsgId == null &&
              !["completed", "failed", "cancelled", "superseded"].includes(
                activeTask.status,
              ) && (
                <div className="mt-4">
                  <TaskStream
                    task={activeTask}
                    messages={taskMessages}
                    connectionLost={connectionLost}
                    provider={runtimeProvider}
                  />
                </div>
              )}
          </div>
        </div>
        <ScrollToBottomButton scrollRef={scrollRef} />
      </div>

      {/* Input */}
      <div data-keyboard-offset className="relative z-10 px-3 sm:px-4 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-6">
        <div className="mx-auto max-w-3xl relative">
          {/* Social presence line — "{Name} is typing…" while this conversation
              has a live task (dispatched / queued / running), else nothing. */}
          {conversation && (
            <PresenceLine
              agentFirstName={agentFirstName}
              taskStatus={isTaskActive ? activeTask?.status : null}
            />
          )}
          <div className="flex items-end gap-2">
            {/* Overflow menu */}
            {!targetConvId && (
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 self-end mb-2 size-8 rounded-full text-muted-foreground/60 hover:text-foreground transition-colors duration-200"
                    />
                  }
                >
                  <MenuToggleIcon open={menuOpen} />
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-auto p-2 flex flex-col gap-1"
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
                          ? "Take a nap and reset the current session"
                          : `${agentName} is well-rested and ready to go`}
                    </TooltipContent>
                  </Tooltip>
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
                              handleStop();
                            }}
                            disabled={stopping || !isTaskActive}
                            className="w-full justify-start gap-2 rounded-md text-muted-foreground hover:text-foreground"
                          >
                            {stopping ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Square className="size-3.5" />
                            )}
                            <span className="text-xs">Stop</span>
                          </Button>
                        </span>
                      )}
                    />
                    <TooltipContent side="right">
                      {isTaskActive
                        ? "Stop the running task"
                        : "No task running"}
                    </TooltipContent>
                  </Tooltip>
                </PopoverContent>
              </Popover>
            )}

            {/* Pill container */}
            <div
              className={cn(
                "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border/50 bg-background/90 transition-[border-radius] duration-200",
                "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
                (isMultiLine || quotedMessage || slashCommand.activeSkill) &&
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
                    isMultiLine || quotedMessage || slashCommand.activeSkill
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
                <div className="flex items-center gap-2 px-4 pt-2.5 pb-1 border-b border-border/50">
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="shrink-0 text-xs font-medium text-primary">
                      /{slashCommand.activeSkill.name}
                    </span>
                    {slashCommand.activeSkill.isGlobal && (
                      <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded px-1 py-1">
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
                    className="shrink-0 p-1 rounded-sm hover:bg-muted-foreground/20 transition-colors text-muted-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {quotedMessage && (
                <div className="flex items-center gap-2 px-4 pt-2.5 pb-1 border-b border-border/50">
                  <div className="flex-1 min-w-0 flex items-start gap-2">
                    <MessageSquareQuote className="size-3.5 shrink-0 mt-1 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground truncate max-w-50">
                      {quotedMessage.excerpt}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setQuotedMessage(null)}
                    className="shrink-0 p-1 rounded-sm hover:bg-muted-foreground/20 transition-colors text-muted-foreground"
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
              {/* Pending file previews — images and non-images in separate rows */}
              {pendingFiles.length > 0 && (() => {
                const images = pendingFiles.map((pf, i) => ({ pf, i })).filter(({ pf }) => pf.thumbnailUrl);
                const others = pendingFiles.map((pf, i) => ({ pf, i })).filter(({ pf }) => !pf.thumbnailUrl);
                return (
                  <div className="px-4 pt-3 pb-0.5 space-y-2">
                    {images.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {images.map(({ pf, i }) => (
                          <div key={`${pf.file.name}-${i}`} className="relative group">
                            <button
                              type="button"
                              onClick={() => {
                                const url = URL.createObjectURL(pf.file);
                                setLightboxLocalUrl({ url, filename: pf.file.name });
                              }}
                              className="cursor-pointer"
                            >
                              <img
                                src={pf.thumbnailUrl!}
                                alt={pf.file.name}
                                className="h-12 w-auto rounded-md object-cover"
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => removePendingFile(i)}
                              className="absolute -top-2 -right-2 size-4 rounded-full bg-muted-foreground text-background flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <X className="size-2.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {others.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {others.map(({ pf, i }) => (
                          <span
                            key={`${pf.file.name}-${i}`}
                            className="inline-flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                          >
                            <FileText className="size-3 shrink-0" />
                            <span className="truncate max-w-30">{pf.file.name}</span>
                            <span className="text-muted-foreground/60">
                              {formatSize(pf.file.size)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removePendingFile(i)}
                              className="ml-1 rounded-sm p-1 hover:bg-muted-foreground/20 transition-colors"
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
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
                    onFocus={() => setComposerFocused(true)}
                    onBlur={() => setComposerFocused(false)}
                    // The overlay is the SOLE placeholder renderer (TipTap's own
                    // placeholder stays "" — it can't reactively update post-init,
                    // which is what caused the active↔idle double-image). Shown
                    // whenever the field is empty, in both states:
                    //  • active task → static "Message {Name}" (no rotation). Warm,
                    //    no period (Priya); reads the same whether or not a task runs.
                    //  • idle → the rotating capability hint.
                    overlay={
                      input.trim() === "" ? (
                        isTaskActive ? (
                          <RotatingPlaceholderOverlay
                            hint={`Message ${agentFirstName}`}
                            animate={false}
                          />
                        ) : (
                          <RotatingPlaceholderOverlay
                            hint={rotatingPlaceholder.hint}
                            animate={rotatingPlaceholder.isRotating}
                          />
                        )
                      ) : undefined
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
                {/* Send button — fixed bottom-right. Always Send; never a
                    Stop/pause affordance (task-lifecycle chrome is gone). The
                    spinner is only the sub-second in-flight double-submit guard. */}
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
              </div>
            </div>
          </div>
        </div>
      </div>

      <ImageLightbox
        open={lightboxArtifact != null}
        onClose={() => setLightboxArtifact(null)}
        artifact={lightboxArtifact}
        workspaceId={workspaceId}
      />
      {lightboxLocalUrl && (
        <ImageLightbox
          open
          onClose={() => {
            URL.revokeObjectURL(lightboxLocalUrl.url);
            setLightboxLocalUrl(null);
          }}
          imageUrl={lightboxLocalUrl.url}
          filename={lightboxLocalUrl.filename}
        />
      )}

      <ArtifactSheet
        open={artifactSheetOpen}
        onOpenChange={(v) => {
          setArtifactSheetOpen(v);
          if (!v)
            setTimeout(() => {
              setSelectedArtifact(null);
            }, 300);
        }}
        artifacts={selectedArtifact ? [selectedArtifact] : agentArtifacts}
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
