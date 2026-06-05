"use client";

import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  type MutableRefObject,
} from "react";
import { flushSync } from "react-dom";
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
  getActiveTask,
  retryTask,
  markInboxRead,
  listFlaggedMessageIds,
} from "@/lib/api";
import {
  appendCachedMessage,
  getCachedMessages,
  getCachedMessagesBefore,
  getCacheMeta,
  mergeCachedMessages,
  getLastOpenConversation,
  setLastOpenConversation,
  getConvExtras,
  setConvExtras,
} from "@/lib/chat-cache";
import {
  createFastLoadGateState,
  fastLoadKey,
  shouldSkipFastLoad,
  markFastLoadCompleted,
} from "@/components/agent-chat/fast-load-gate";
import {
  sortMessages,
  mergeMessages,
  computeGroupPositions,
  buildTimeline,
  shouldPersistPointerForLoad,
  pointerRefreshTargetForTaskCreated,
  useLatest,
} from "@/components/agent-chat/chat-message-utils";
import type { NapMarker } from "@/components/agent-chat/chat-message-utils";
import type { PreviousConversation } from "@/lib/api";
import type {
  Agent,
  Artifact,
  Conversation,
  Message,
  SkillEntry,
  TaskApi as Task,
  TaskMessageResponse,
  WsMessage,
} from "@alook/shared";
import { toast } from "sonner";
import type { ChatComposerHandle } from "@/components/agent-chat/chat-composer";
import { useCachedMessages } from "@/hooks/use-cached-messages";
import { trackAgentChatOpened, trackMessageSent } from "@/lib/analytics";

const MESSAGE_LIMIT = 20;
const MAX_CONV_FETCHES_PER_CLICK = 5;

export interface UseAgentChatProps {
  agentId: string;
  targetConvId: string | null;
  scrollToTaskId: string | null;
  scrollToMessageId: string | null;
  propTargetConvId?: string | null;
  workspaceId: string;
  agents: Agent[];
  activeChannel: string;
  channelLoading: boolean;
  subscribeWs: (cb: (msg: WsMessage) => void) => () => void;
  subscribeReconnect: (cb: () => void) => () => void;
  refreshInboxCount: () => void;
}

export interface UseAgentChatExternal {
  // (a) Setters the hook WRITES — state owned outside the hook, passed IN.
  setFlaggedIds: (ids: Set<string>) => void;
  setPendingFiles: (files: File[]) => void;
  setInput: (value: string) => void;
  setQuotedMessage: (value: { id: string; excerpt: string } | null) => void;
  setActiveSkill: (skill: SkillEntry | null) => void;
  clearActiveSkill: () => void;
  // (b) Values the hook READS — owned outside, passed IN via useLatest ref.
  inputRef: MutableRefObject<string>;
  quotedMessageRef: MutableRefObject<{ id: string; excerpt: string } | null>;
  pendingFilesRef: MutableRefObject<File[]>;
  activeSkillRef: MutableRefObject<SkillEntry | null>;
  // Component-owned ref written by the load effect (gates draft-meta persist).
  draftMetaRestoredRef: MutableRefObject<boolean>;
}

export function useAgentChat(
  props: UseAgentChatProps,
  external: UseAgentChatExternal,
) {
  const {
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
  } = props;
  const {
    setFlaggedIds,
    setPendingFiles,
    setInput,
    setQuotedMessage,
    setActiveSkill,
    clearActiveSkill,
    inputRef,
    quotedMessageRef,
    pendingFilesRef,
    activeSkillRef,
    draftMetaRestoredRef,
  } = external;

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [taskMessages, setTaskMessages] = useState<TaskMessageResponse[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [previousConversations, setPreviousConversations] = useState<
    PreviousConversation[]
  >([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [napMarkers, setNapMarkers] = useState<NapMarker[]>([]);

  const [pendingFilesByMessage, setPendingFilesByMessage] = useState<
    Map<string, File[]>
  >(() => new Map());
  // Optimistic sends that failed to reach the server. The bubble stays in place
  // with an inline "Not delivered · tap to retry" affordance (iMessage-style),
  // keyed by the optimistic message id → the content + files to resend.
  const [failedSends, setFailedSends] = useState<
    Map<string, { content: string; files: File[] }>
  >(() => new Map());

  const { writeToCache } = useCachedMessages(targetConvId ?? null, workspaceId);
  const writeToCacheRef = useRef(writeToCache);
  useEffect(() => {
    writeToCacheRef.current = writeToCache;
  }, [writeToCache]);

  const chatOpenedTracked = useRef(false);
  useEffect(() => {
    if (!conversation || chatOpenedTracked.current) return;
    chatOpenedTracked.current = true;
    trackAgentChatOpened({
      agent_id: agentId,
      is_first_chat: messages.length === 0,
    });
  }, [conversation, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const agentArtifacts = useMemo(
    () => artifacts.filter((a) => a.source === "agent"),
    [artifacts],
  );

  const timeline = useMemo(
    () => buildTimeline(messages, agentArtifacts, napMarkers, conversation?.id),
    [messages, agentArtifacts, napMarkers, conversation?.id],
  );
  const groupPositions = useMemo(
    () => computeGroupPositions(timeline),
    [timeline],
  );

  // The live error-surface (TaskStream) must attach to at most ONE message per
  // active task — otherwise multiple `send-dm` replies sharing a taskId would
  // each render the (errors-only) stream wrapper. Pick the LAST assistant
  // message of the active task; MessageItem gates `hasTaskStream` on this id.
  const activeTaskStreamMsgId = useMemo(() => {
    if (!activeTask) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.task_id === activeTask.id) return m.id;
    }
    return null;
  }, [messages, activeTask]);

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
  // TipTap composer imperative handle (focus / clear / isEmpty / anchor coords).
  const composerRef = useRef<ChatComposerHandle>(null);

  // Persist a live-updated artifacts array to the cached card metadata so the
  // next instant open includes it. Read-modify-write: reads the existing
  // `conv_extras` row (which holds the conversation_type/title/channel/
  // created_at from the last network write) and replaces only `artifacts`.
  //
  // Best-effort and fire-and-forget (review MEDIUM-2): if two updates race
  // within the write window, the loser may write a momentarily-short list — NOT
  // data loss, because the next `conversationInit` does a full-replace write of
  // the authoritative server artifacts. We skip the write when no extras row
  // exists yet (artifact arrived before the first network write) — the imminent
  // network/post-task write lands the full row. Guarded on `loadConvIdRef` so a
  // write never lands on a switched-away or not-yet-confirmed conversation.
  const persistArtifactsToCache = useCallback(
    (conversationId: string, nextArtifacts: Artifact[]) => {
      if (loadConvIdRef.current !== conversationId) return;
      getConvExtras(conversationId, workspaceId)
        .then((extras) => {
          if (!extras) return;
          if (loadConvIdRef.current !== conversationId) return;
          return setConvExtras(
            conversationId,
            {
              artifacts: nextArtifacts,
              conversation_type: extras.conversation_type,
              conversation_title: extras.conversation_title,
              conversation_channel: extras.conversation_channel,
              conversation_created_at: extras.conversation_created_at,
              hasMoreArtifacts: extras.hasMoreArtifacts,
            },
            workspaceId,
          );
        })
        .catch(() => { });
    },
    [workspaceId],
  );

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
    setPendingFilesByMessage(new Map());
    setFailedSends(new Map());
    setNapMarkers([]);
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
        const q = meta.quote;
        setQuotedMessage(q && typeof q === "object" && q.id ? q : null);
        setActiveSkill(
          meta.skill ? (meta.skill as SkillEntry) : null,
        );
      } catch {
        setQuotedMessage(null);
        setActiveSkill(null);
      }
    } else {
      setQuotedMessage(null);
      setActiveSkill(null);
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
          // Paint the cards (artifacts + event-card icon/label) from cache in
          // the same frame as the text, so they don't pop in after the network
          // round-trip. Both pieces are overwritten by the authoritative
          // network values in Phase B — this is purely a no-reflow first paint.
          await paintExtrasFromCache(convId, cached);
          return { painted: true, cacheMeta };
        }
      }
      return { painted: false, cacheMeta };
    }

    // Apply the cached card metadata (artifacts + a provisional conversation
    // stub) for `convId`. The stub exists only so `conversationType` resolves
    // the event-card icon/label correctly on first paint; the network's
    // `setConversation(data.conversation)` overwrites the whole stub afterward.
    // `paintedMessages` is the just-painted cached message list, used to derive
    // a `created_at` fallback so we never seed an empty string (which would
    // flip the scroll heuristic's `!conversation.created_at` branch).
    async function paintExtrasFromCache(
      convId: string,
      paintedMessages: Message[],
    ): Promise<void> {
      const extras = await getConvExtras(convId, workspaceId);
      if (ignore || !extras) return;
      setArtifacts(extras.artifacts);
      const createdAt =
        extras.conversation_created_at ||
        paintedMessages[0]?.created_at ||
        paintedMessages[paintedMessages.length - 1]?.created_at ||
        "";
      setConversation((prev) =>
        // Seed the provisional stub only when no conversation is set yet, OR
        // when the existing one is for a DIFFERENT conversation (a switch from
        // A→B: replace A's stale stub with B's). Never clobber an authoritative
        // conversation already fetched for THIS `convId` — `prev.id === convId`
        // means the network landed first (or this is a same-conversation
        // re-run, e.g. a scrollToTaskId change), so keep the real value.
        prev && prev.id === convId
          ? prev
          : {
              id: convId,
              agent_id: agentId,
              title: extras.conversation_title,
              type: extras.conversation_type,
              channel: extras.conversation_channel,
              created_at: createdAt,
            },
      );
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
                // Also clear the optimistically-painted cards from conversation
                // A. With extras now seeding `artifacts` on the optimistic
                // paint, a corrected conversation with no cache would otherwise
                // keep showing A's artifact cards until Phase B responds. The
                // provisional `conversation` stub is overwritten by Phase B's
                // authoritative `setConversation(data.conversation)` (MEDIUM-3).
                // When `res.painted` is true, paintFromCache already re-seeded
                // the corrected conversation's own cards.
                setArtifacts([]);
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
              ).catch(() => { });
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
            ).catch(() => { });
          }
          setArtifacts(data.artifacts);
          // Persist the authoritative card metadata so the next open paints the
          // artifact cards + correct event-card types instantly from cache.
          // Guarded on the stale-closure ref (same as the message write above)
          // so we never write extras for a switched-away conversation;
          // fire-and-forget, off the critical path.
          if (loadConvIdRef.current === convId) {
            setConvExtras(
              convId,
              {
                artifacts: data.artifacts,
                conversation_type: data.conversation.type,
                conversation_title: data.conversation.title,
                conversation_channel: data.conversation.channel,
                conversation_created_at: data.conversation.created_at,
                hasMoreArtifacts: data.has_more_artifacts,
              },
              workspaceId,
            ).catch(() => { });
          }
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
              // Errors-only: thinking is no longer rendered (replies arrive via
              // `send-dm`); we keep only the live error channel.
              const errorMsgs = tmsgs.filter((m) => m.type === "error");
              setTaskMessages(errorMsgs);
              // Advance the cursor past all fetched seqs (incl. dropped
              // thinking) so the poll/WS don't reconsider them.
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
          setHasMoreConversations(data.has_more_conversations);
          mergeCachedMessages(
            data.conversation.id,
            data.messages,
            data.has_more_messages,
            workspaceId,
          ).catch(() => { });
          // Persist the card metadata from the chatInit fallback too (same
          // shape as the conversationInit write above), guarded on the
          // stale-closure ref. ChatInit's response carries the same
          // `artifacts` + `conversation` + `has_more_artifacts` fields.
          if (loadConvIdRef.current === data.conversation.id) {
            setConvExtras(
              data.conversation.id,
              {
                artifacts: data.artifacts,
                conversation_type: data.conversation.type,
                conversation_title: data.conversation.title,
                conversation_channel: data.conversation.channel,
                conversation_created_at: data.conversation.created_at,
                hasMoreArtifacts: data.has_more_artifacts,
              },
              workspaceId,
            ).catch(() => { });
          }
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
          ).catch(() => { });
          if (hasCachedMessages && initialScrollDone.current && wasNearBottom) {
            scrollToBottom();
          }
          listFlaggedMessageIds(workspaceId, data.conversation.id)
            .then((r) => {
              if (!ignore) setFlaggedIds(new Set(r.message_ids));
            })
            .catch(() => { });
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
        .catch(() => { });
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
        // Start at the bottom so the scroll-to-target effect scrolls UP (short
        // distance to a recent task) instead of DOWN from the top (long distance
        // through the entire conversation history).
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
      el.scrollIntoView({ behavior: "smooth", block: "center" });
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
      el.scrollIntoView({ behavior: "smooth", block: "center" });
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

  // Auto-scroll when a new agent-side item lands while the user is at the
  // bottom — covers artifact (file) cards and event cards, which grow the
  // thread via setArtifacts / setMessages without otherwise nudging scroll.
  // (Previously only message text scrolled; cards appeared off-screen until the
  // next message arrived.)
  useEffect(() => {
    if (scrollTargetActiveRef.current) return;
    if (!initialScrollDone.current) return;
    if (isNearBottom.current) scrollToBottom();
  }, [artifacts.length, messages.length, scrollToBottom]);

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
            ).catch(() => { });
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
        // A new poll was started (e.g. by a steering task) — bail out
        if (pollTaskIdRef.current !== taskId) return;

        try {
          // Thin status-only poll: fetch only task status/error as a resilience
          // fallback for a dropped WebSocket. Replies arrive via `send-dm` ->
          // `conversation.message`, and live errors via the `task.messages` WS
          // (filtered to errors-only) — the poll no longer fetches task_messages.
          const task = await getTask(taskId, workspaceId);

          // Re-check after await — a steering task may have started a new poll
          const isStale = pollTaskIdRef.current !== taskId;

          pollFailures.current = 0;
          setConnectionLost(false);

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
                  ).catch(() => { });
                })
                .catch(() => { });
              return;
            }

            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;

            if (markReadTimerRef.current)
              clearTimeout(markReadTimerRef.current);
            markReadTimerRef.current = setTimeout(() => {
              markInboxRead(conversationId, workspaceId)
                .then(() => refreshInboxCountRef.current())
                .catch(() => { });
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
              ).catch(() => { });
              if (arts) {
                setArtifacts(arts);
                // Full-replace persist of the authoritative post-task artifacts
                // so the cache stays consistent with what's rendered.
                persistArtifactsToCache(conversationId, arts);
              }
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

            // Fallback: if a steering task superseded this one but the
            // WebSocket message was lost, detect the new active task via API.
            setTimeout(async () => {
              if (pollRef.current) return;
              try {
                const nextTask = await getActiveTask(
                  conversationId,
                  workspaceId,
                );
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
                  ).catch(() => { });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persistArtifactsToCache is stable (useCallback with no deps)
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
          // Thinking is no longer rendered — the reply lands via `send-dm`. Keep
          // ONLY `type:"error"` items: they are a live error channel (opencode /
          // codex emit them mid-run, sometimes without the task transitioning to
          // failed) and dropping them would hide real failures.
          const errorsOnly = incoming.filter((m) => m.type === "error");
          if (errorsOnly.length > 0) {
            setTaskMessages((prev) => {
              const existingSeqs = new Set(prev.map((m) => m.seq));
              const unique = errorsOnly.filter((m) => !existingSeqs.has(m.seq));
              return unique.length > 0 ? [...prev, ...unique] : prev;
            });
          }
          // Advance the cursor past every seq we've seen (incl. dropped
          // thinking) so we never reconsider them.
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
            ).catch(() => { });
          })
          .catch(() => { });
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
          .catch(() => { });
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
          ).catch(() => { });
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
              const optimisticId = prev[optimisticIdx].id;
              setPendingFilesByMessage((p) => {
                if (!p.has(optimisticId)) return p;
                const next = new Map(p);
                next.delete(optimisticId);
                return next;
              });
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
          const next = [...prev, msg.artifact];
          // Persist the appended artifact to the cached card metadata so it
          // renders instantly on the next open. Dedupe by id is handled above
          // (we only reach here for a genuinely new artifact). Guarded inside
          // `persistArtifactsToCache` on `loadConvIdRef`. The persist is an
          // idempotent fire-and-forget read-modify-write, so the Strict-Mode
          // dev double-invoke just writes the same row twice — harmless.
          persistArtifactsToCache(msg.conversationId, next);
          return next;
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeChannelRef is a stable ref, read inside to avoid re-subscribing on channel change
  }, [subscribeWs, conversation?.id, workspaceId, agentId, persistArtifactsToCache]);

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
                .catch(() => { });
            }
          })
          .catch(() => { });
      });
    });
  }, [subscribeReconnect, conversation?.id, workspaceId]);

  const handleSend = async () => {
    const rawContent = inputRef.current.trim();
    if ((!rawContent && pendingFilesRef.current.length === 0) || sending || !conversation)
      return;
    if (!rawContent) {
      toast.error("Please type a message");
      return;
    }

    let content = rawContent;
    const quoteRef = quotedMessageRef.current;

    // Prepend skill instruction if active
    if (activeSkillRef.current) {
      content = `/${activeSkillRef.current.name} ${content}`;
    }

    const filesToSend = [...pendingFilesRef.current];
    trackMessageSent({ agent_id: agentId, message_length: content.length });
    setInput("");
    setPendingFiles([]);
    setQuotedMessage(null);
    clearActiveSkill();
    setSending(true);

    // Every send goes through the same enqueue-and-steer path: POST /messages
    // enqueues a real task carrying contextKey=conversationId, so when a task
    // is already running the daemon supersedes it (steering). No client-side
    // buffering — sending while busy just drops a new bubble and steers.
    const optimisticId = `temp-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId,
      conversation_id: conversation.id,
      role: "user",
      content,
      task_id: null,
      attachment_ids: null,
      ...(quoteRef ? { metadata: { quote: { messageId: quoteRef.id, excerpt: quoteRef.excerpt } } } : {}),
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
        quoteRef ? { quote: { messageId: quoteRef.id, excerpt: quoteRef.excerpt } } : undefined,
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
        () => { },
      );
      if (message.attachment_ids && message.attachment_ids.length > 0) {
        const convId = conversation.id;
        listArtifacts(convId, workspaceId)
          .then((arts) => {
            setArtifacts(arts);
            // Keep the cached card metadata consistent with the artifacts shown
            // after a send-with-attachments refresh (full replace).
            persistArtifactsToCache(convId, arts);
          })
          .catch(() => { });
      }
      setActiveTask(task);
      setTaskMessages([]);
      startPolling(task.id, conversation.id);
    } catch {
      // Keep the optimistic bubble in place and surface an inline
      // "Not delivered · tap to retry" affordance instead of a toast (Priya).
      setFailedSends((prev) => {
        const next = new Map(prev);
        next.set(optimisticId, { content, files: filesToSend });
        return next;
      });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  };

  // Resend a failed optimistic message: drop the dead bubble + its failed state,
  // then run the normal send with the stored content/files.
  const handleRetrySend = useCallback(
    (messageId: string) => {
      const failed = failedSends.get(messageId);
      if (!failed || !conversation || sending) return;

      setFailedSends((prev) => {
        const next = new Map(prev);
        next.delete(messageId);
        return next;
      });
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setPendingFilesByMessage((prev) => {
        if (!prev.has(messageId)) return prev;
        const next = new Map(prev);
        next.delete(messageId);
        return next;
      });
      setSending(true);

      const optimisticId = `temp-${Date.now()}`;
      const optimistic: Message = {
        id: optimisticId,
        conversation_id: conversation.id,
        role: "user",
        content: failed.content,
        task_id: null,
        attachment_ids: null,
        created_at: new Date().toISOString(),
      };
      if (failed.files.length > 0) {
        setPendingFilesByMessage((prev) => {
          const next = new Map(prev);
          next.set(optimisticId, failed.files);
          return next;
        });
      }
      setMessages((prev) => [...prev, optimistic]);

      sendMessage(
        conversation.id,
        failed.content,
        workspaceId,
        failed.files.length > 0 ? failed.files : undefined,
      )
        .then(({ message, task }) => {
          setPendingFilesByMessage((prev) => {
            if (!prev.has(optimisticId)) return prev;
            const next = new Map(prev);
            next.delete(optimisticId);
            return next;
          });
          setMessages((prev) => {
            const without = prev.filter(
              (m) => m.id !== optimisticId && m.id !== message.id,
            );
            return sortMessages([...without, message]);
          });
          appendCachedMessage(conversation.id, message, workspaceId).catch(
            () => { },
          );
          setActiveTask(task);
          setTaskMessages([]);
          startPolling(task.id, conversation.id);
        })
        .catch(() => {
          setFailedSends((prev) => {
            const next = new Map(prev);
            next.set(optimisticId, failed);
            return next;
          });
        })
        .finally(() => {
          setSending(false);
        });
    },
    [failedSends, conversation, sending, workspaceId, startPolling],
  );

  const handleRetryTask = useCallback(async () => {
    if (!activeTask || !conversation) return;
    const newTask = await retryTask(activeTask.id, workspaceId);
    setActiveTask(newTask);
    setTaskMessages([]);
    startPolling(newTask.id, conversation.id);
  }, [activeTask, conversation, workspaceId, startPolling]);

  const [napping, setNapping] = useState(false);

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
      setPendingFiles([]);
      setPendingFilesByMessage(new Map());
      setFailedSends(new Map());
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

  return {
    // hook-owned state
    conversation,
    messages,
    sending,
    activeTask,
    taskMessages,
    messagesLoading,
    connectionLost,
    hasMore,
    loadingMore,
    artifacts,
    previousConversations,
    hasMoreConversations,
    napMarkers,
    napping,
    pendingFilesByMessage,
    failedSends,
    // derived
    agentArtifacts,
    agentName,
    timeline,
    groupPositions,
    activeTaskStreamMsgId,
    canLoadMore,
    currentConvHasMessages,
    // refs shared with the JSX
    scrollRef,
    composerRef,
    // handlers
    loadOlderMessages,
    handleScroll,
    handleSend,
    handleRetrySend,
    handleRetryTask,
    handleNap,
    scrollToBottom,
  };
}
