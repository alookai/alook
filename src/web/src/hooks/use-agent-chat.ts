"use client";

import {
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { flushSync } from "react-dom";
import {
  chatInit as chatInitApi,
  checkFreshness as checkFreshnessApi,
  conversationInit as conversationInitApi,
  createConversation as createConversationApi,
  listMessages as listMessagesApi,
  listMessagesAroundTask as listMessagesAroundTaskApi,
  listPreviousConversations as listPreviousConversationsApi,
  sendMessage as sendMessageApi,
  getTask as getTaskApi,
  getTaskMessages as getTaskMessagesApi,
  listArtifacts as listArtifactsApi,
  getActiveTask as getActiveTaskApi,
  retryTask as retryTaskApi,
  markInboxRead as markInboxReadApi,
  listFlaggedMessageIds as listFlaggedMessageIdsApi,
} from "@/lib/api";
import {
  chatExtrasKey, chatMessagesKey, sortedChatMessages, type ChatMessagesData, type ChatExtras,
  getCachedMessages,
  getCachedMessagesBefore,
  getCacheMeta,
  mergeCachedMessages,
  getLastOpenConversation,
  setLastOpenConversation,
} from "@/lib/chat-cache";
import {
  fastLoadKey,
} from "@/components/agent-chat/fast-load-gate";
import {
  sortMessages,
  mergeMessages,
  computeGroupPositions,
  buildTimeline,
  shouldPersistPointerForLoad,
  pointerRefreshTargetForTaskCreated,
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
import type { PendingFile } from "@/hooks/use-file-attachments";
import type { ChatComposerHandle } from "@/components/agent-chat/chat-composer";
import { getArtifactThumbnailUrl } from "@/components/artifact-content-renderer";
import { useIsRestoring, useIsMutating, useMutation, skipToken, useQuery, QueryObserver, InfiniteQueryObserver, isCancelledError } from "@tanstack/react-query";
import type { ApiRequestOptions } from "@/lib/api/client";
import { ApiError, isAbortError } from "@/lib/errors";
import { useAtom, useCreateAtom, createStore, useSelector } from "@tanstack/react-store";
import type { ChatFlagsData } from "@/lib/workspace-chat-flags";
import { useChatData, captureChatIntent, assertChatIntent, runChatIntentRequest } from "@/hooks/workspace/use-chat-data";
import { useWorkspaceOwner, workspaceRequestOptions } from "@/contexts/workspace-context";
import { observeChatRead, chatReadSource, chatMessagePageOptions, chatAroundTaskOptions, readChatMessageIds, chatArtifactOptions, chatTaskOptions, readChatTask, chatTaskMessagesOptions, chatActiveTaskOptions, chatPreviousOptions, chatFlagsOptions } from "@/hooks/workspace/chat-query-options";
import { isQueryReceiptCurrent } from "@/lib/query-receipt";
import { captureChatLoad, settleChatLoad } from "@/lib/workspace-chat-load";
import { trackAgentChatOpened, trackMessageSent } from "@/lib/analytics";

const isChatCancellation = (error: unknown) => isAbortError(error) || isCancelledError(error);
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
  readActiveChannel: () => string;
  channelLoading: boolean;
  subscribeWs: (cb: (msg: WsMessage) => void) => () => void;
  subscribeReconnect: (cb: () => void) => () => void;
  refreshInboxCount: () => void;
}

export interface UseAgentChatExternal {
  // (a) Setters the hook WRITES — state owned outside the hook, passed IN.
  setPendingFiles: (files: PendingFile[]) => void;
  setInput: (value: string) => void;
  setQuotedMessage: (value: { id: string; excerpt: string } | null) => void;
  setActiveSkill: (skill: SkillEntry | null) => void;
  clearActiveSkill: () => void;
  readInput: () => string;
  readQuotedMessage: () => { id: string; excerpt: string } | null;
  readPendingFiles: () => PendingFile[];
  readActiveSkill: () => SkillEntry | null;
  markDraftRestored: () => void;
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
    readActiveChannel,
    channelLoading,
    subscribeWs,
    subscribeReconnect,
    refreshInboxCount,
  } = props;
  const {
    setPendingFiles,
    setInput,
    setQuotedMessage,
    setActiveSkill,
    clearActiveSkill,
    readInput,
    readQuotedMessage,
    readPendingFiles,
    readActiveSkill,
    markDraftRestored,
  } = external;

  const workspaceOwner = useWorkspaceOwner();
  const isRestoring = useIsRestoring();
  if (workspaceOwner.workspaceId !== workspaceId) throw new DOMException("Wrong chat workspace", "AbortError");
  const chatViewIdentity = JSON.stringify([agentId, targetConvId, targetConvId ? null : activeChannel]);
  const chatData = useChatData(workspaceOwner, chatViewIdentity, targetConvId);
  const chatActions = chatData.actions;
  const { conversation, setConversation, messages, setMessages, artifacts, activeTask, setActiveTask, taskMessages, hasMore, setHasMore, previousConversations, setPreviousConversations, hasMoreConversations, setHasMoreConversations } = chatData;
  const { mutateAsync: mutateChatCommand } = useMutation({ mutationKey: workspaceOwner.key("chat", "command"), gcTime: 0, mutationFn: (operation: () => Promise<unknown>) => operation() });
  const withChatOrigin = useCallback(<T,>(operation: (options: ApiRequestOptions) => Promise<T>, options?: ApiRequestOptions, mutation = false): Promise<T> => {
    const intent = captureChatIntent(workspaceOwner, chatActions.view);
    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const assertActive = () => { assertChatIntent(intent, signal); options?.assertActive?.(); };
    assertActive();
    const onChange = () => { try { assertActive(); } catch { controller.abort(); } };
    const subscriptions = [chatActions.view, workspaceOwner.lifecycle, workspaceOwner.application.lifecycle].map((store) => store.subscribe(onChange));
    const load = async () => {
      try { assertActive(); const result = await operation({ ...options, ...workspaceRequestOptions(intent.workspace, signal, assertActive) }); assertActive(); return result; }
      catch (error) { assertActive(); throw error; }
      finally { for (const subscription of subscriptions) subscription.unsubscribe(); }
    };
    return mutation ? mutateChatCommand(load) as Promise<T> : load();
  }, [workspaceOwner, chatActions.view, mutateChatCommand]);
  const chatInit = useCallback(async (...args: Parameters<typeof chatInitApi>) => { const tickets = captureChatLoad(workspaceOwner); const data = await withChatOrigin((options) => chatInitApi(args[0], args[1], args[2], options), args[3], false); return settleChatLoad(workspaceOwner, data, tickets); }, [withChatOrigin, workspaceOwner]);
  const checkFreshness = useCallback((...args: Parameters<typeof checkFreshnessApi>) => withChatOrigin((options) => checkFreshnessApi(args[0], args[1], options), args[2], false), [withChatOrigin]);
  const conversationInit = useCallback(async (...args: Parameters<typeof conversationInitApi>) => {
    const tickets = captureChatLoad(workspaceOwner);
    const flagsRequestRevision = workspaceOwner.queryClient.getQueryData<ChatFlagsData>(workspaceOwner.key("chat", "flags", args[0]))?.revision ?? 0;
    const data = await withChatOrigin((options) => conversationInitApi(args[0], args[1], args[2], options), args[3], false);
    return { ...settleChatLoad(workspaceOwner, data, tickets), flagsRequestRevision };
  }, [withChatOrigin, workspaceOwner]);
  const listMessages = useCallback(async (...args: Parameters<typeof listMessagesApi>) => {
    const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[3]);
    const options = chatMessagePageOptions(source, args[0], args[2]);
    let data: ChatMessagesData;
    if (args[2]?.before && workspaceOwner.queryClient.getQueryData(options.queryKey)) {
      const observer = new InfiniteQueryObserver(workspaceOwner.queryClient, { ...options, enabled: false });
      const release = observeChatRead(source, observer);
      try {
        await observer.fetchNextPage({ cancelRefetch: false, throwOnError: true });
        source.assertActive();
        data = workspaceOwner.queryClient.getQueryData<ChatMessagesData>(options.queryKey)!;
      } finally { release(); }
    } else {
      const observer = new InfiniteQueryObserver(workspaceOwner.queryClient, { ...options, enabled: false });
      const release = observeChatRead(source, observer);
      try { data = await workspaceOwner.queryClient.fetchInfiniteQuery(options) as ChatMessagesData; } finally { release(); }
    }
    source.assertActive();
    data = workspaceOwner.queryClient.getQueryData<ChatMessagesData>(options.queryKey)!;
    const cursor = args[2];
    const eligible = sortedChatMessages(data).filter((row) => !cursor?.before || row.created_at < cursor.before || row.created_at === cursor.before && row.id < (cursor.beforeId ?? ""));
    const messages = eligible.slice(-(cursor?.limit ?? 20));
    return { messages, has_more: eligible.length > messages.length || data.pages.at(-1)?.hasMore === true };
  }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const listMessagesAroundTask = useCallback(async (...args: Parameters<typeof listMessagesAroundTaskApi>) => { const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[3]); const options = chatAroundTaskOptions(source, args[0], args[2]); const release = observeChatRead(source, new QueryObserver(workspaceOwner.queryClient, { ...options, enabled: false })); let ids; try { ids = await workspaceOwner.queryClient.fetchQuery(options); } finally { release(); } return readChatMessageIds(source, args[0], ids); }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const listPreviousConversations = useCallback(async (...args: Parameters<typeof listPreviousConversationsApi>) => {
    const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[3]);
    const options = chatPreviousOptions(source, args[0], args[2]);
    let data;
    const old = workspaceOwner.queryClient.getQueryData(options.queryKey);
    if (old && old.pageParams.includes(args[2].before)) data = old;
    else if (old) {
      const observer = new InfiniteQueryObserver(workspaceOwner.queryClient, { ...options, enabled: false });
      const release = observeChatRead(source, observer);
      try { data = (await observer.fetchNextPage({ cancelRefetch: false, throwOnError: true })).data; }
      finally { release(); }
    } else {
      const observer = new InfiniteQueryObserver(workspaceOwner.queryClient, { ...options, enabled: false });
      const release = observeChatRead(source, observer);
      try { data = await workspaceOwner.queryClient.fetchInfiniteQuery(options); } finally { release(); }
    }
    source.assertActive();
    chatActions.selectPreviousResource(options.queryKey);
    const index = data?.pageParams.indexOf(args[2].before) ?? -1;
    return data?.pages[index < 0 ? data.pages.length - 1 : index] ?? { conversations: [], has_more: false };
  }, [workspaceOwner, chatActions, chatViewIdentity]);
  const sendMessage = useCallback((...args: Parameters<typeof sendMessageApi>) => withChatOrigin((options) => sendMessageApi(args[0], args[1], args[2], args[3], args[4], options), args[5], true), [withChatOrigin]);
  const getTask = useCallback(async (...args: Parameters<typeof getTaskApi>) => { const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[2]); const options = chatTaskOptions(source, args[0]); const release = observeChatRead(source, new QueryObserver(workspaceOwner.queryClient, { ...options, enabled: false })); try { await workspaceOwner.queryClient.fetchQuery(options); } finally { release(); } source.assertActive(); return workspaceOwner.queryClient.getQueryData<Task>(options.queryKey)!; }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const getTaskMessages = useCallback(async (...args: Parameters<typeof getTaskMessagesApi>) => { const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[3]); const options = chatTaskMessagesOptions(source, args[0]); const release = observeChatRead(source, new QueryObserver(workspaceOwner.queryClient, { ...options, enabled: false })); try { await workspaceOwner.queryClient.fetchQuery(options); } finally { release(); } source.assertActive(); return (workspaceOwner.queryClient.getQueryData<TaskMessageResponse[]>(options.queryKey) ?? []).filter((row) => args[2] === undefined || row.seq > args[2]); }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const listArtifacts = useCallback(async (...args: Parameters<typeof listArtifactsApi>) => { const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[2]); const options = chatArtifactOptions(source, args[0]); const release = observeChatRead(source, new QueryObserver(workspaceOwner.queryClient, { ...options, enabled: false })); try { await workspaceOwner.queryClient.fetchQuery(options); } finally { release(); } source.assertActive(); return workspaceOwner.queryClient.getQueryData<ChatExtras>(options.queryKey)?.artifacts ?? []; }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const getActiveTask = useCallback(async (...args: Parameters<typeof getActiveTaskApi>) => { const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[2]); const options = chatActiveTaskOptions(source, args[0]); const release = observeChatRead(source, new QueryObserver(workspaceOwner.queryClient, { ...options, enabled: false })); try { await workspaceOwner.queryClient.fetchQuery(options); } finally { release(); } source.assertActive(); const currentId = workspaceOwner.queryClient.getQueryData<{ id: string | null }>(options.queryKey)?.id; return currentId ? readChatTask(source, currentId) : undefined; }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const markInboxRead = useCallback((...args: Parameters<typeof markInboxReadApi>) => withChatOrigin((options) => markInboxReadApi(args[0], args[1], options), args[2], true), [withChatOrigin]);
  const listFlaggedMessageIds = useCallback(async (...args: Parameters<typeof listFlaggedMessageIdsApi>) => { const source = chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity, args[2]); const options = chatFlagsOptions(source, args[1]); const release = observeChatRead(source, new QueryObserver(workspaceOwner.queryClient, { ...options, enabled: false })); let ids; try { ids = await workspaceOwner.queryClient.fetchQuery(options); } finally { release(); } source.assertActive(); return { message_ids: ids.ids }; }, [workspaceOwner, chatActions.view, chatViewIdentity]);
  const [messagesLoading, setMessagesLoading] = useAtom(useCreateAtom(true));
  const [napMarkers, setNapMarkers] = useAtom(useCreateAtom<NapMarker[]>([]));

  const [pendingFilesByMessage, setPendingFilesByMessage] = useAtom(useCreateAtom<Map<string, PendingFile[]>>((() => new Map())()));
  const [failedSends, setFailedSends] = useAtom(useCreateAtom<Map<string, { content: string; files: PendingFile[] }>>((() => new Map())()));

  // Maps real (server) message IDs back to their optimistic (temp-*) IDs so
  // the React key used in the timeline stays stable when the optimistic message
  // is replaced — preventing an unmount/remount flash of the entire row.
  const [stableKeyMap, setStableKeyMap] = useAtom(useCreateAtom<Map<string, string>>((() => new Map())()));






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
  const pollState = useMemo(() => ({ scope: [chatActions.view], store: createStore({ target: null as { taskId: string; conversationId: string; intent: ReturnType<typeof captureChatIntent> } | null }) }), [chatActions.view]).store;
  const pollTarget = useSelector(pollState, (state) => state.target);
  const followupTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const protocol = useMemo(() => ({ scope: [chatActions.view], store: createStore({ chatOpenedTracked: false, lastSeq: 0, pollFailures: 0, loadingMore: false, oldestCursor: null as PreviousConversation | null, backfillAttempts: 0, previousConversationId: undefined as string | undefined, loadedConversationId: null as string | null, markedReadId: null as string | null, completedLoadKey: null as string | null }) }), [chatActions.view]).store;
  useEffect(() => {
    if (!conversation || protocol.get().chatOpenedTracked) return;
    protocol.setState((state) => ({ ...state, chatOpenedTracked: true }));
    trackAgentChatOpened({
      agent_id: agentId,
      is_first_chat: messages.length === 0,
    });
  }, [conversation, agentId, chatActions.view]); // eslint-disable-line react-hooks/exhaustive-deps


  const loadingMore = useSelector(protocol, (state) => state.loadingMore);
  const connectionLost = useSelector(protocol, (state) => state.pollFailures >= 3);
  const initialScrollDone = useRef(false);

  const isNearBottom = useRef(true);
  const scrollTargetActiveRef = useRef(false);
  const startPollingRef = useRef<
    | ((taskId: string, conversationId: string, initialSeq?: number) => void)
    | null
  >(null);



  // The server-confirmed conversation id for the current load. Cache writes
  // (mergeCachedMessages / appendCachedMessage / setLastOpenConversation) must
  // guard on this so a write never lands on an optimistically-rendered (not yet
  // confirmed) conversation during the cache-first window. Stays null until
  // checkFreshness / chatInit / conversationInit confirms an id.

  // Dedup gate for the fast-path load: skips a redundant re-run when only
  // channel deps (activeChannel / channelLoading) change, WITHOUT stranding the
  // skeleton if a run is cancelled mid-flight. See fast-load-gate.ts (Part 2-a /
  // TODO 6 + stuck-skeleton fix).

  // TipTap composer imperative handle (focus / clear / isEmpty / anchor coords).
  const composerRef = useRef<ChatComposerHandle>(null);

  const scrollToBottom = useCallback(() => {
    isNearBottom.current = true;
    setTimeout(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 50);
  }, []);

  // Preload server thumbnail images in the background, then delete the
  // corresponding pendingFilesByMessage entries and revoke their blob URLs.
  // This prevents layout shift: the browser image cache is warm before we
  // remove the local blob source, so the <img> switches without a flash.
  const preloadThenCleanPending = useCallback(
    (arts: Artifact[], _conversationId: string) => {
      const intent = captureChatIntent(workspaceOwner, chatActions.view);
      assertChatIntent(intent);
      // Collect thumbnail URLs for image artifacts that have server thumbnails.
      const thumbUrls = arts
        .filter((a) => a.content_type.startsWith("image/") && a.has_thumbnail)
        .map((a) => getArtifactThumbnailUrl(a.id, workspaceId));

      function preloadImage(url: string): Promise<void> {
        return new Promise((resolve) => {
          const img = new window.Image();
          img.onload = () => resolve();
          img.onerror = () => resolve(); // don't block cleanup on failure
          img.src = url;
        });
      }

      // Preload all thumbnails, then clean up only pending entries whose
      // artifacts are actually resolved — avoids prematurely clearing entries
      // for a second message still being uploaded.
      const artIdSet = new Set(arts.map((a) => a.id));
      Promise.all(thumbUrls.map(preloadImage)).then(() => {
        try { assertChatIntent(intent); } catch { return; }
        setPendingFilesByMessage((prev) => {
          if (prev.size === 0) return prev;
          const msgs = sortedChatMessages(workspaceOwner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(workspaceOwner, _conversationId)));
          const next = new Map(prev);
          let changed = false;
          for (const [msgId, files] of prev) {
            const msg = msgs.find((m) => m.id === msgId);
            const ids = msg?.attachment_ids;
            if (ids && ids.length > 0 && ids.every((id: string) => artIdSet.has(id))) {
              for (const pf of files) {
                if (pf.thumbnailUrl) URL.revokeObjectURL(pf.thumbnailUrl);
              }
              next.delete(msgId);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      });
    },
    [workspaceOwner, chatActions.view, workspaceId, setPendingFilesByMessage],
  );

  useEffect(() => {
    // The slow path (no targetConvId) resolves the conversation id via the
    // server using activeChannel, so it must wait for the channel list. The
    // fast path (known targetConvId) and the cache-first optimistic paint need
    // neither activeChannel nor a loaded channel list, so they must NOT be
    // gated by channelLoading (Part 2-a). channelLoading stays in the dep array
    // so the slow path retries once channels load.
    if (isRestoring || !targetConvId && channelLoading) return;

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
    if (fastKey && protocol.get().completedLoadKey === fastKey) return;
    protocol.setState((state) => ({ ...state, completedLoadKey: null }));

    pollState.setState(() => ({ target: null }));
    protocol.setState((state) => ({ ...state, loadingMore: false }));
    protocol.setState((state) => ({ ...state, loadedConversationId: null }));
    let ignore = false;
    setMessagesLoading(true);
    initialScrollDone.current = false;
    // Revoke blob URLs before clearing the map — they were kept alive for the
    // session to avoid layout shift, so this is the only place they get freed.
    setPendingFilesByMessage((prev) => {
      for (const files of prev.values()) {
        for (const pf of files) {
          if (pf.thumbnailUrl) URL.revokeObjectURL(pf.thumbnailUrl);
        }
      }
      return new Map();
    });
    setFailedSends(new Map());
    setStableKeyMap(new Map());
    setNapMarkers([]);
    setPreviousConversations([]);
    setHasMoreConversations(false);
    protocol.setState((state) => ({ ...state, oldestCursor: null }));
    setInput(
      localStorage.getItem(
        `chat-draft:${workspaceOwner.application.userId}:${workspaceId}:${agentId}:${targetConvId ?? "default"}`,
      ) ?? "",
    );
    const metaRaw = localStorage.getItem(
      `chat-draft-meta:${workspaceOwner.application.userId}:${workspaceId}:${agentId}:${targetConvId ?? "default"}`,
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
    markDraftRestored();
    setMessages([]);

    // Paint cached messages for a known conversation id without any network.
    // Returns true if it painted, so the caller can suppress the loading
    // skeleton until the background reconcile runs.
    async function paintFromCache(convId: string): Promise<{
      painted: boolean;
      cacheMeta: Awaited<ReturnType<typeof getCacheMeta>>;
    }> {
      const cacheMeta = await getCacheMeta(convId, workspaceOwner);
      if (cacheMeta?.newestMessageId) {
        const cached = await getCachedMessages(convId, workspaceOwner);
        if (ignore) return { painted: false, cacheMeta };
        if (cached && cached.length > 0) {
          setMessages(cached);
          setHasMore(cacheMeta.hasMore, convId!);
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

    async function paintExtrasFromCache(convId: string, _paintedMessages: Message[]): Promise<void> {
      const cached = workspaceOwner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(workspaceOwner, convId));
      if (ignore || !cached?.conversation) return;
      chatActions.selectConversation(convId);
    }

    async function load(signal: AbortSignal) {
      const loadIntent = captureChatIntent(workspaceOwner, chatActions.view);
      const requestOptions = { signal, assertActive: () => assertChatIntent(loadIntent, signal) };
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
      assertChatIntent(loadIntent);
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
            workspaceOwner,
          );
      assertChatIntent(loadIntent);
          if (ignore) return;
          if (lastOpen?.conversation_id && lastOpen.serverMessageCount > 0) {
            const res = await paintFromCache(lastOpen.conversation_id);
      assertChatIntent(loadIntent);
            if (ignore) return;
            if (res.painted) {
              hasCachedMessages = true;
              optimisticConvId = lastOpen.conversation_id;
              cacheMeta = res.cacheMeta;
            }
          }

          // Background freshness check — does NOT gate the paint above.
          try {
            const fresh = await checkFreshness({ agentId, channel: activeChannel }, workspaceId, requestOptions);
      assertChatIntent(loadIntent);
            if (ignore) return;
            convId = fresh.conversation_id;

            if (optimisticConvId && convId !== optimisticConvId) {
              // We painted the wrong/stale conversation. Swap to the correct
              // one and reset scroll intent so the initial-scroll effect
              // re-fires for the new message set (review #2).
              initialScrollDone.current = false;
              isNearBottom.current = true;
              const res = await paintFromCache(convId);
      assertChatIntent(loadIntent);
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
                chatActions.selectConversation(convId);
              }
            } else if (!optimisticConvId) {
              // Nothing painted yet — read the resolved conversation's cache.
              const res = await paintFromCache(convId);
      assertChatIntent(loadIntent);
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
          } catch (error) {
            if (isChatCancellation(error) || error instanceof ApiError && error.status === 401) throw error;
            // checkFreshness failed — fall back to chatInit below
          }
        }

        // Phase B: full data fetch (background hydration or stale-cache refresh)
        if (convId) {
          protocol.setState((state) => ({ ...state, loadedConversationId: convId }));
          const data = await conversationInit(convId, workspaceId, {
            newestMessageId: cacheMeta?.newestMessageId ?? undefined,
            // 0 means "count unknown" (e.g. cached via the chatInit fallback,
            // which has no server total) — omit the param so the server skips
            // the count compare and relies on newestMessageId alone. Sending
            // "0" would make the server's `serverMessageCount === 0` check fail
            // for every non-empty conversation, forcing a needless full merge.
            messageCount: cacheMeta?.serverMessageCount || undefined,
          }, requestOptions);
      assertChatIntent(loadIntent);
          if (ignore) return;
          setConversation(data.conversation);
          if (data.root_message) {
            workspaceOwner.queryClient.setQueryData(workspaceOwner.key("chat", "thread-root", data.conversation.id), { conversationId: data.root_message.conversation_id, id: data.root_message.id });
          } else workspaceOwner.queryClient.setQueryData(workspaceOwner.key("chat", "thread-root", data.conversation.id), null);
          setHasMoreConversations(data.has_more_conversations);
          if (!data.cache_valid && data.messages) {
            // Stale cache — merge server data in place, preserving scroll
            // position unless the user was already near the bottom (A2 / TODO 5).
            const wasNearBottom = isNearBottom.current;
            setMessages((prev) => mergeMessages(prev, data.messages!));
            if (protocol.get().loadedConversationId === convId) {
              mergeCachedMessages(
                convId,
                data.messages,
                data.has_more_messages,
                workspaceOwner,
                data.message_count,
              ).catch(() => { });
            }
            setHasMore(data.has_more_messages, data.conversation.id);
            if (
              hasCachedMessages &&
              initialScrollDone.current &&
              wasNearBottom
            ) {
              scrollToBottom();
            }
          } else if (cacheMeta) {
            setHasMore(cacheMeta.hasMore, convId!);
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
            protocol.get().loadedConversationId === convId &&
            shouldPersistPointerForLoad(targetConvId)
          ) {
            const confirmedMeta = await getCacheMeta(convId, workspaceOwner);
      assertChatIntent(loadIntent);
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
              workspaceOwner,
            ).catch(() => { });
          }
          // Persist the authoritative card metadata so the next open paints the
          // artifact cards + correct event-card types instantly from cache.
          // Guarded on the stale-closure ref (same as the message write above)
          // so we never write extras for a switched-away conversation;
          // fire-and-forget, off the critical path.

          workspaceOwner.queryClient.setQueryData(workspaceOwner.key("chat", "flags", data.conversation.id), { ids: data.flagged_message_ids, requestRevision: data.flagsRequestRevision } satisfies ChatFlagsData);
          if (data.active_task) {
            if (data.task_messages.length > 0) {
              protocol.setState((state) => ({ ...state, lastSeq: Math.max(
                ...data.task_messages.map((m) => m.seq),
              ) }));
            }
            startPollingRef.current?.(
              chatActions.readActiveTaskId() ?? data.active_task.id,
              convId,
              protocol.get().lastSeq,
            );
          }
          if (scrollToTaskId) {
            const task = await getTask(scrollToTaskId, workspaceId, requestOptions).catch(
              (error) => { if (isChatCancellation(error)) throw error; assertChatIntent(loadIntent, signal); return null; },
            );
      assertChatIntent(loadIntent);
            if (ignore) return;
            if (
              task &&
              !["completed", "failed", "cancelled", "superseded"].includes(
                task.status,
              )
            ) {
              setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(workspaceOwner.key("chat", "task", task.id)) ?? null);
              const tmsgs = await getTaskMessages(scrollToTaskId, workspaceId, undefined, requestOptions).catch((error) => { if (isChatCancellation(error)) throw error; assertChatIntent(loadIntent, signal); return [] as TaskMessageResponse[]; });
      assertChatIntent(loadIntent);
              if (ignore) return;
              // Errors-only: thinking is no longer rendered (replies arrive via
              // `send-dm`); we keep only the live error channel.

              // Advance the cursor past all fetched seqs (incl. dropped
              // thinking) so the poll/WS don't reconsider them.
              if (tmsgs.length > 0) {
                protocol.setState((state) => ({ ...state, lastSeq: Math.max(...tmsgs.map((m) => m.seq)) }));
              }
              startPollingRef.current?.(task.id, convId, protocol.get().lastSeq);
            }
          }
        } else {
          // checkFreshness failed entirely — fall back to chatInit
          const data = await chatInit(agentId, workspaceId, activeChannel, requestOptions);
      assertChatIntent(loadIntent);
          if (ignore) return;
          protocol.setState((state) => ({ ...state, loadedConversationId: data.conversation.id }));
          setConversation(data.conversation);
          const wasNearBottom = isNearBottom.current;
          setMessages((prev) =>
            prev.length > 0
              ? mergeMessages(prev, data.messages)
              : data.messages,
          );
          setHasMore(data.has_more_messages, data.conversation.id);
          setHasMoreConversations(data.has_more_conversations);
          mergeCachedMessages(
            data.conversation.id,
            data.messages,
            data.has_more_messages,
            workspaceOwner,
          ).catch(() => { });
          // Persist the card metadata from the chatInit fallback too (same
          // shape as the conversationInit write above), guarded on the
          // stale-closure ref. ChatInit's response carries the same
          // `artifacts` + `conversation` + `has_more_artifacts` fields.

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
            workspaceOwner,
          ).catch(() => { });
          if (hasCachedMessages && initialScrollDone.current && wasNearBottom) {
            scrollToBottom();
          }
          listFlaggedMessageIds(workspaceId, data.conversation.id, requestOptions)
            .catch(() => { });
          if (data.active_task) {
            if (data.task_messages.length > 0) {
                protocol.setState((state) => ({ ...state, lastSeq: Math.max(
                ...data.task_messages.map((m) => m.seq),
              ) }));
            }
            if (
              !["completed", "failed", "cancelled", "superseded"].includes(
                data.active_task.status,
              )
            ) {
              startPollingRef.current?.(
                chatActions.readActiveTaskId() ?? data.active_task.id,
                data.conversation.id,
                protocol.get().lastSeq,
              );
            }
          }
        }
      } catch (error) {
        if (isChatCancellation(error) || signal.aborted || ignore) return;
        assertChatIntent(loadIntent, signal);
        if (!hasCachedMessages) {
          toast.error("Failed to load conversation");
        } else {
          toast.error("Couldn't refresh conversation");
        }
      } finally {
        if (!ignore && !signal.aborted) {
          try { assertChatIntent(loadIntent, signal); } catch { return; }
          setMessagesLoading(false);
          // Mark this fast-path identity as completed only now, so a re-fire
          // caused purely by a channel-dep change is deduped (TODO 6) — while a
          // run cancelled before reaching here leaves no marker, letting the
          // successor run take over and clear the skeleton.
          if (fastKey) protocol.setState((state) => ({ ...state, completedLoadKey: fastKey }));
        }
      }
    }
    const queryKey = workspaceOwner.key("chat", "open", chatViewIdentity, fastKey);
    void workspaceOwner.queryClient.fetchQuery({ queryKey, staleTime: 0, gcTime: 0, retry: false, queryFn: async ({ signal }) => { await load(signal); return { conversationId: protocol.get().loadedConversationId }; } }).catch(() => {});
    return () => {
      ignore = true;
      if (!chatActions.view.get().active) protocol.setState((state) => ({ ...state, completedLoadKey: null }));
      void workspaceOwner.queryClient.cancelQueries({ queryKey, exact: true });
      void workspaceOwner.queryClient.cancelQueries({ queryKey: workspaceOwner.key("chat", "io", chatViewIdentity) });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, workspaceId, targetConvId, scrollToTaskId, activeChannel, channelLoading, isRestoring, chatActions.view]);

  const refreshInboxCountRef = useRef(refreshInboxCount);
  useEffect(() => {
    refreshInboxCountRef.current = refreshInboxCount;
  }, [refreshInboxCount, chatActions.view]);


  useEffect(() => {
    if (!conversation?.id || !workspaceId) return;
    if (protocol.get().markedReadId === conversation.id) return;
    protocol.setState((state) => ({ ...state, markedReadId: conversation.id }));
    const intent = captureChatIntent(workspaceOwner, chatActions.view);
    const timer = setTimeout(() => {
      try { assertChatIntent(intent); } catch { return; }
      markInboxRead(conversation.id, workspaceId, { assertActive: () => assertChatIntent(intent) })
        .then(() => { assertChatIntent(intent); refreshInboxCountRef.current(); })
        .catch(() => { });
    }, 1000);
    return () => {
      protocol.setState((state) => ({ ...state, markedReadId: null }));
      clearTimeout(timer);
    };
  }, [conversation?.id, workspaceId, chatActions.view, protocol, workspaceOwner, markInboxRead]);

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
  }, [messagesLoading, messages.length, scrollToTaskId, scrollToMessageId, propTargetConvId, chatActions.view]);

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
  }, [scrollToTaskId, messagesLoading, conversation, workspaceId, chatActions.view, listMessagesAroundTask, setMessages]);

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
  }, [scrollToMessageId, scrollToTaskId, messagesLoading, conversation, chatActions.view]);

  // Auto-scroll when task badge appears or new task steps arrive
  const taskStatus = activeTask?.status;
  useEffect(() => {
    if (scrollTargetActiveRef.current) return;
    const isRunning = taskStatus === "running" || taskStatus === "queued";
    if (isRunning && isNearBottom.current) {
      scrollToBottom();
    }
  }, [taskMessages.length, taskStatus, scrollToBottom, chatActions.view]);

  // Auto-scroll when a new agent-side item lands while the user is at the
  // bottom — covers artifact (file) cards and event cards, which grow the
  // thread via setArtifacts / setMessages without otherwise nudging scroll.
  // (Previously only message text scrolled; cards appeared off-screen until the
  // next message arrived.)
  useEffect(() => {
    if (scrollTargetActiveRef.current) return;
    if (!initialScrollDone.current) return;
    if (isNearBottom.current) scrollToBottom();
  }, [artifacts.length, messages.length, scrollToBottom, chatActions.view]);

  const agentName = useMemo(
    () => agents.find((a) => a.id === agentId)?.name ?? "Agent",
    [agents, agentId],
  );

  const readAgentName = useCallback(() => workspaceOwner.queryClient.getQueryData<Agent[]>(workspaceOwner.key("agents"))?.find((row) => row.id === agentId)?.name ?? "Agent", [workspaceOwner, agentId]);

  const loadOlderMessages = useCallback(
    async (scrollToEnd = false) => {
      if (!conversation || protocol.get().loadingMore) return;
      const intent = captureChatIntent(workspaceOwner, chatActions.view);
      const chainOptions = { assertActive: () => assertChatIntent(intent) };
      protocol.setState((state) => ({ ...state, loadingMore: true }));
      try {

      const currentMessages = chatActions.readMessages();
      const currentHasMore = chatActions.readHasMore();
      const currentHasMoreConvs = chatActions.readHasMoreConversations();
      const currentAgentName = readAgentName();
      const currentChannel = readActiveChannel();
      const isSingleConvView = !!targetConvId;

      const oldest = currentMessages[0];
      const paginatingConvId =
        protocol.get().oldestCursor?.id ?? conversation.id;
      const canLoadMoreInConv = currentHasMore && oldest;
      let prevConvsList = chatActions.readPrevious();

      if (
        !isSingleConvView &&
        !canLoadMoreInConv &&
        prevConvsList.length === 0 &&
        currentHasMoreConvs
      ) {
        const oldestConv = protocol.get().oldestCursor ?? {
          id: conversation.id,
          created_at: conversation.created_at,
        };
        try {
          const result = await listPreviousConversations(agentId, workspaceId, {
            exclude: conversation.id,
            before: oldestConv.created_at,
            channel: currentChannel,
          }, chainOptions);
      assertChatIntent(intent);
          prevConvsList = result.conversations;
          setPreviousConversations(result.conversations);
          setHasMoreConversations(result.has_more);
        } catch (error) {
          if (isChatCancellation(error)) throw error;
          assertChatIntent(intent);
          setHasMoreConversations(false);
        }
      }

      const canLoadPrevConv = !isSingleConvView && prevConvsList.length > 0;

      if (!canLoadMoreInConv && !canLoadPrevConv) {
        protocol.setState((state) => ({ ...state, loadingMore: false }));
        return;
      }

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
                workspaceOwner,
              )
              : null;
      assertChatIntent(intent);

          if (cached) {
            phase1Messages = cached.messages;
            remaining -= cached.messages.length;
            lastHasMore = cached.hasMore;
          } else {
            const result = await listMessages(paginatingConvId, workspaceId, {
              limit: MESSAGE_LIMIT,
              before: oldest!.created_at,
              beforeId: oldest!.id,
            }, chainOptions);
      assertChatIntent(intent);
            phase1Messages = result.messages;
            remaining -= result.messages.length;
            lastHasMore = result.has_more;
          }
          phase1HasMore = lastHasMore;
        }

        // --- Phase 2: Load from previous conversations (only in timeline mode) ---
        if (!isSingleConvView && !lastHasMore && remaining > 0) {
          if (prevConvsList.length === 0 && currentHasMoreConvs) {
            const oldestConv = protocol.get().oldestCursor ?? {
              id: conversation.id,
              created_at: conversation.created_at,
            };
            try {
              const result = await listPreviousConversations(agentId, workspaceId, {
                  exclude: conversation.id,
                  before: oldestConv.created_at,
                  channel: currentChannel,
                }, chainOptions
              );
      assertChatIntent(intent);
              prevConvsList = result.conversations;
              setPreviousConversations(result.conversations);
              setHasMoreConversations(result.has_more);
            } catch (error) {
              if (isChatCancellation(error)) throw error;
              assertChatIntent(intent);
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
            }, chainOptions);
      assertChatIntent(intent);

            if (result.messages.length === 0) {
              protocol.setState((state) => ({ ...state, oldestCursor: prevConv }));
              continue;
            }

            const napTs =
              protocol.get().oldestCursor?.created_at ??
              conversation.created_at;
            napMarkersToAdd.push({
              agentName: currentAgentName,
              created_at: napTs,
              id: `nap-${prevConv.id}`,
            });

            phase2Messages = [...result.messages, ...phase2Messages];
            remaining -= result.messages.length;
            lastHasMore = result.has_more;
            protocol.setState((state) => ({ ...state, oldestCursor: prevConv }));
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
            setHasMore(lastHasMore, protocol.get().oldestCursor?.id ?? conversation.id);
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
              workspaceOwner,
            ).catch(() => { });
          }
        }

        protocol.setState((state) => ({ ...state, loadingMore: false }));
        flushSync(() => protocol.setState((state) => ({ ...state, loadingMore: false })));

        if (el) {
          if (scrollToEnd) {
            el.scrollTop = el.scrollHeight;
          } else {
            const newScrollHeight = el.scrollHeight;
            el.scrollTop = newScrollHeight - prevScrollHeight;
          }
        }
      } catch (error) {
        if (isChatCancellation(error)) return;
        assertChatIntent(intent);
        toast.error("Failed to load older messages");
      } finally {
        try { assertChatIntent(intent); } catch { return; }
        protocol.setState((state) => ({ ...state, loadingMore: false }));
            if (scrollRef.current) scrollRef.current.style.overflowAnchor = "";
      }
      } catch (error) {
        if (isChatCancellation(error)) return;
        try { assertChatIntent(intent); } catch { return; }
        toast.error("Failed to load older messages");
      } finally {
        try { assertChatIntent(intent); } catch { return; }
        protocol.setState((state) => ({ ...state, loadingMore: false }));
      }
    },
    [conversation, protocol, workspaceOwner, chatActions, readAgentName, readActiveChannel, targetConvId, listPreviousConversations, agentId, workspaceId, setPreviousConversations, setHasMoreConversations, listMessages, setHasMore, setMessages, setNapMarkers],
  );

  const canLoadMore = targetConvId
    ? hasMore
    : hasMore || previousConversations.length > 0 || hasMoreConversations;

  useEffect(() => {
    if (conversation?.id === protocol.get().previousConversationId) return;
    protocol.setState((state) => ({ ...state, previousConversationId: conversation?.id }));
    protocol.setState((state) => ({ ...state, backfillAttempts: 0 }));
  }, [conversation?.id, chatActions.view, protocol]);

  const MIN_MESSAGES = 10;
  useEffect(() => {
    if (messagesLoading || !conversation) return;
    if (scrollToTaskId || targetConvId) return;
    if (messages.length >= MIN_MESSAGES || !canLoadMore) return;
    if (loadingMore) return;
    if (protocol.get().backfillAttempts >= 3) return;
    protocol.setState((state) => ({ ...state, backfillAttempts: state.backfillAttempts + (1) }));
    loadOlderMessages(true);
  }, [messagesLoading, messages.length, canLoadMore, loadingMore, conversation, loadOlderMessages, scrollToTaskId, targetConvId, chatActions.view, protocol]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, []);

  const startPolling = useCallback((taskId: string, conversationId: string, initialSeq?: number) => {
    const intent = captureChatIntent(workspaceOwner, chatActions.view);
    assertChatIntent(intent);
    protocol.setState((state) => ({ ...state, lastSeq: initialSeq ?? 0 }));
    protocol.setState((state) => ({ ...state, pollFailures: 0 }));
    protocol.setState((state) => ({ ...state, pollFailures: 0 }));
    pollState.setState(() => ({ target: { taskId, conversationId, intent } }));
  }, [workspaceOwner, chatActions.view, protocol, pollState]);
  useEffect(() => { startPollingRef.current = startPolling; }, [startPolling]);

  const pollFactSource = useMemo(() => pollTarget ? chatReadSource(workspaceOwner, chatActions.view, chatViewIdentity) : null, [workspaceOwner, chatActions.view, chatViewIdentity, pollTarget]);
  const pollQuery = useQuery({
    ...(pollFactSource ? chatTaskOptions(pollFactSource, pollTarget!.taskId) : { queryKey: workspaceOwner.key("chat", "task", "__none__"), queryFn: skipToken }),
    enabled: !!pollTarget,
    subscribed: !!pollTarget,
    retry: false,
    staleTime: 3000,
    refetchInterval: pollTarget ? 3000 : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (!pollTarget || pollQuery.isFetching) return;
    const { taskId, conversationId, intent } = pollTarget;
    const controller = new AbortController();
    const assertActive = () => assertChatIntent(intent, controller.signal);
    const chainOptions = { signal: controller.signal, assertActive };
    const settle = async () => {
      try {
        assertActive();
        if (pollQuery.error) throw pollQuery.error;
        const task = pollQuery.data;
        if (!task) return;
        assertActive();
        protocol.setState((state) => ({ ...state, pollFailures: 0 }));
        protocol.setState((state) => ({ ...state, pollFailures: 0 }));
        if (["completed", "failed", "cancelled", "superseded"].includes(task.status)) {
          if (pollState.get().target?.taskId !== taskId) {
            const result = await listMessages(conversationId, workspaceId, undefined, chainOptions);
            assertActive();
            setMessages((previous) => mergeMessages(previous, result.messages));
            return task;
          }
          const shouldScroll = !scrollTargetActiveRef.current && isNearBottom.current;
          try {
            const [result, arts] = await Promise.all([
              listMessages(conversationId, workspaceId, undefined, chainOptions),
              listArtifacts(conversationId, workspaceId, chainOptions).catch((error) => {
                if (isChatCancellation(error)) throw error;
                assertActive();
                return null;
              }),
            ]);
            assertActive();
            setMessages((previous) => mergeMessages(previous, result.messages));
            if (arts) preloadThenCleanPending(arts, conversationId);
            setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(workspaceOwner.key("chat", "task", task.id)) ?? null);
          } catch (error) {
            if (isChatCancellation(error)) throw error;
            assertActive();
            setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(workspaceOwner.key("chat", "task", task.id)) ?? null);
            toast.error("Failed to refresh messages");
          }
          assertActive();
          if (pollState.get().target?.taskId === taskId) pollState.setState(() => ({ target: null }));
          if (shouldScroll) requestAnimationFrame(() => {
            try { assertChatIntent(intent); } catch { return; }
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          });
          if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
          markReadTimerRef.current = setTimeout(() => {
            try { assertChatIntent(intent); } catch { return; }
            markInboxRead(conversationId, workspaceId, { assertActive: () => assertChatIntent(intent) })
              .then(() => { assertChatIntent(intent); refreshInboxCountRef.current(); }).catch(() => {});
          }, 1000);
          const timer = setTimeout(async () => {
            followupTimers.current.delete(timer);
            try {
              assertChatIntent(intent);
              if (pollState.get().target) return;
              const options = { assertActive: () => assertChatIntent(intent) };
              const nextTask = await getActiveTask(conversationId, workspaceId, options);
              assertChatIntent(intent);
              if (nextTask && nextTask.id !== taskId) {
                const result = await listMessages(conversationId, workspaceId, undefined, options);
                assertChatIntent(intent);
                setMessages((previous) => mergeMessages(previous, result.messages));
                setActiveTask(nextTask);

                startPollingRef.current?.(nextTask.id, conversationId);
              }
            } catch {}
          }, 1000);
          followupTimers.current.add(timer);
        } else if (pollState.get().target?.taskId === taskId) setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(workspaceOwner.key("chat", "task", task.id)) ?? null);
        assertActive();
        return task;
      } catch (error) {
        if (isChatCancellation(error)) throw error;
        assertActive();
        if (pollState.get().target?.taskId === taskId) {
          protocol.setState((state) => ({ ...state, pollFailures: state.pollFailures + (1) }));
          if (protocol.get().pollFailures >= 10) {
            pollState.setState(() => ({ target: null }));
            toast.error("Lost connection to agent");
          }
        }
      }
    };
    void settle().catch(() => {});
    return () => controller.abort();
  }, [pollTarget, pollQuery.dataUpdatedAt, pollQuery.errorUpdatedAt, chatActions.view, pollQuery.isFetching, pollQuery.error, pollQuery.data, protocol, pollState, setActiveTask, workspaceOwner, listMessages, workspaceId, setMessages, listArtifacts, preloadThenCleanPending, markInboxRead, getActiveTask]);

  useEffect(() => () => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    for (const timer of followupTimers.current) clearTimeout(timer);
    followupTimers.current.clear();
  }, [chatActions.view]);



  useEffect(() => {
    const intent = captureChatIntent(workspaceOwner, chatActions.view);
    const chainOptions = { assertActive: () => assertChatIntent(intent) };
    return subscribeWs((msg: WsMessage) => {
      try { assertChatIntent(intent); } catch { return; }
      if (
        msg.type === "task.messages" &&
        msg.taskId === chatActions.readActiveTaskId()
      ) {
        const incoming = msg.messages.filter((m) => m.seq > protocol.get().lastSeq);
        if (incoming.length > 0) {
          // Thinking is no longer rendered — the reply lands via `send-dm`. Keep
          // ONLY `type:"error"` items: they are a live error channel (opencode /
          // codex emit them mid-run, sometimes without the task transitioning to
          // failed) and dropping them would hide real failures.
          // Advance the cursor past every seq we've seen (incl. dropped
          // thinking) so we never reconsider them.
          protocol.setState((state) => ({ ...state, lastSeq: Math.max(
            ...incoming.map((m) => m.seq),
            protocol.get().lastSeq,
          ) }));
        }
      }
      if (
        msg.type === "task.created" &&
        msg.conversationId === conversation?.id
      ) {
        listMessages(msg.conversationId, workspaceId, undefined, chainOptions)
          .then(({ messages: latest }) => {
            assertChatIntent(intent);
            setMessages((prev) => mergeMessages(prev, latest));
            mergeCachedMessages(
              msg.conversationId,
              latest,
              null,
              workspaceOwner,
            ).catch(() => { });
          })
          .catch(() => { });
        const task = msg.task as Task;
        setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(workspaceOwner.key("chat", "task", task.id)) ?? null);
        protocol.setState((state) => ({ ...state, lastSeq: 0 }));
        startPollingRef.current?.(task.id, msg.conversationId);
      }
      // Refresh the per-channel `last_open` pointer when a `task.created`
      // arrives — this is the client learning of a (possibly newer) conversation
      // for this agent+channel in real time, keeping the pointer's
      // "latest-created" semantics fresh while the user is on the page. Runs
      // independently of the active-conversation block above: a new thread spawned
      // in this channel often has a different conversationId than the one being
      // viewed, so it must NOT be gated on `msg.conversationId === conversation?.id`.
      if (msg.type === "task.created") {
        const task = msg.task as Task;
        const activeChannel = readActiveChannel();
        getLastOpenConversation(agentId, activeChannel, workspaceOwner)
          .then((current) => {
            assertChatIntent(intent);
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
            return getCacheMeta(targetConvId, workspaceOwner).then((meta) =>
              { assertChatIntent(intent); return setLastOpenConversation(
                agentId,
                activeChannel,
                {
                  conversation_id: targetConvId,
                  newestMessageId: meta?.newestMessageId ?? null,
                  serverMessageCount: meta?.messageCount ?? 0,
                },
                workspaceOwner,
              ); },
            );
          })
          .catch(() => { });
      }
      if (msg.type === "conversation.message") {
        // Only cache for the server-confirmed loaded conversation — never write
        // during the optimistic cache-first window before the id is confirmed
        // (review #1).
        if (msg.conversationId === conversation?.id) {
          const incomingTime = new Date(msg.message.created_at).getTime();
          const optimisticMatch = chatActions.readMessages().find(
            (m) =>
              m.id.startsWith("temp-") &&
              m.role === msg.message.role &&
              m.content === msg.message.content &&
              Math.abs(new Date(m.created_at).getTime() - incomingTime) < 2000,
          );
          if (optimisticMatch) {
            setPendingFilesByMessage((p) => {
              if (!p.has(optimisticMatch.id)) return p;
              const files = p.get(optimisticMatch.id)!;
              const next = new Map(p);
              next.delete(optimisticMatch.id);
              next.set(msg.message.id, files);
              return next;
            });
            setStableKeyMap((prev) => {
              if (prev.has(msg.message.id)) return prev;
              const next = new Map(prev);
              next.set(msg.message.id, optimisticMatch.id);
              return next;
            });
          }
          setMessages((prev) => {
            if (optimisticMatch) {
              const idx = prev.findIndex((m) => m.id === optimisticMatch.id);
              if (idx !== -1) {
                const updated = [...prev];
                updated[idx] = msg.message;
                return updated;
              }
            }
            return mergeMessages(prev, [msg.message]);
          });
        }
      }
    });
  }, [subscribeWs, conversation?.id, workspaceId, agentId, chatActions.view, workspaceOwner, chatActions, protocol, listMessages, setActiveTask, setMessages, readActiveChannel, setPendingFilesByMessage, setStableKeyMap]);

  useEffect(() => {
    const intent = captureChatIntent(workspaceOwner, chatActions.view);
    return subscribeReconnect(() => {
      try { assertChatIntent(intent); } catch { return; }
      if (!conversation?.id) return;
      void workspaceOwner.queryClient.fetchQuery({
        queryKey: workspaceOwner.key("chat", "open", chatViewIdentity, "reconnect"), retry: false, staleTime: 0, gcTime: 0,
        queryFn: async ({ signal }) => {
          const assertActive = () => assertChatIntent(intent, signal);
          assertActive();
          const meta = await getCacheMeta(conversation.id, workspaceOwner);
          assertActive();
          const data = await conversationInit(conversation.id, workspaceId, { newestMessageId: meta?.newestMessageId ?? undefined, messageCount: meta?.serverMessageCount ?? undefined }, { signal, assertActive });
          assertActive();
          if (!data.cache_valid && data.messages) {
            await mergeCachedMessages(conversation.id, data.messages, data.has_more_messages, workspaceOwner, data.message_count);
            assertActive();
            setMessages((previous) => mergeMessages(previous, data.messages!));
          }
          return { conversationId: data.conversation.id };
        },
      }).catch(() => {});
    });
  }, [subscribeReconnect, conversation?.id, workspaceId, workspaceOwner, chatViewIdentity, chatActions.view, conversationInit, setMessages]);

  type SendIntent = {
    original: ReturnType<typeof captureChatIntent>;
    conversation: Conversation;
    content: string;
    files: PendingFile[];
    quote: { id: string; excerpt: string } | null;
    retryId?: string;
    rawInput?: string;
    skillName?: string;
  };
  const sendIdentity = useMemo(() => crypto.randomUUID(), []);
  const sendKey = workspaceOwner.key("chat", "send", sendIdentity);
  const sending = useIsMutating({ mutationKey: sendKey, exact: true }) > 0;
  const sendCommand = useMutation<void, Error, SendIntent>({
    mutationKey: sendKey, gcTime: 0,
    mutationFn: async ({ original: intent, conversation, content, files, quote, retryId, rawInput, skillName }) => {
      const assertActive = () => assertChatIntent(intent);
      assertActive();
      const renderFiles = files.map((file) => ({ ...file, thumbnailUrl: file.thumbnailBlob ? URL.createObjectURL(file.thumbnailBlob) : null }));
      if (retryId) {
        setFailedSends((previous) => { const next = new Map(previous); next.delete(retryId); return next; });
        setMessages((previous) => previous.filter((row) => row.id !== retryId));
        setPendingFilesByMessage((previous) => {
          const next = new Map(previous);
          for (const file of next.get(retryId) ?? []) if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl);
          next.delete(retryId); return next;
        });
      } else {
        trackMessageSent({ agent_id: agentId, message_length: content.length });
        if (readInput() === rawInput) setInput("");
        if (readPendingFiles() === files) setPendingFiles([]);
        if (readQuotedMessage()?.id === quote?.id) setQuotedMessage(null);
        if (readActiveSkill()?.name === skillName) clearActiveSkill();
      }
      const optimisticId = `temp-${crypto.randomUUID()}`;
      const optimistic: Message = { id: optimisticId, conversation_id: conversation.id, role: "user", content, task_id: null, attachment_ids: null, ...(quote ? { metadata: { quote: { messageId: quote.id, excerpt: quote.excerpt } } } : {}), created_at: new Date().toISOString() };
      if (renderFiles.length) setPendingFilesByMessage((previous) => new Map(previous).set(optimisticId, renderFiles));
      setMessages((previous) => [...previous, optimistic]);
      scrollToBottom();
      try {
        const tickets = captureChatLoad(workspaceOwner);
        const { message: incoming, task } = await sendMessage(conversation.id, content, workspaceId, files.length ? files : undefined, quote ? { quote: { messageId: quote.id, excerpt: quote.excerpt } } : undefined, { assertActive });
        assertActive();
        const messageKey = chatMessagesKey(workspaceOwner, conversation.id), messageTicket = tickets.get(JSON.stringify(messageKey));
        const current = workspaceOwner.queryClient.getQueryData<ChatMessagesData>(messageKey);
        const message = (current?.liveMessageRevisions?.[incoming.id] ?? 0) > (messageTicket?.liveRevision ?? 0)
          ? sortedChatMessages(current).find((row) => row.id === incoming.id) ?? incoming : incoming;
        const originalMessageResource = messageTicket?.receipt.resource;
        if (originalMessageResource ? workspaceOwner.queryClient.getQueryCache().find({ queryKey: messageKey, exact: true }) === originalMessageResource : !current || (current.liveRevision ?? 0) > 0) await mergeCachedMessages(conversation.id, [message], null, workspaceOwner);
        assertActive();
        const taskKey = workspaceOwner.key("chat", "task", task.id), taskTicket = tickets.get(JSON.stringify(taskKey))?.receipt;
        if (taskTicket ? isQueryReceiptCurrent(taskTicket) : !workspaceOwner.queryClient.getQueryCache().find({ queryKey: taskKey, exact: true })) workspaceOwner.queryClient.setQueryData(taskKey, task);
        setPendingFilesByMessage((previous) => { if (!previous.has(optimisticId)) return previous; const next = new Map(previous); const files = next.get(optimisticId)!; next.delete(optimisticId); next.set(message.id, files); return next; });
        setStableKeyMap((previous) => new Map(previous).set(message.id, optimisticId));
        setMessages((previous) => sortMessages([...previous.filter((row) => row.id !== optimisticId && row.id !== message.id), message]));
        if (message.attachment_ids?.length) void listArtifacts(conversation.id, workspaceId, { assertActive }).then((artifacts) => { assertActive(); preloadThenCleanPending(artifacts, conversation.id); }).catch(() => undefined);
        setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(workspaceOwner.key("chat", "task", task.id)) ?? null);
        startPolling(task.id, conversation.id);
      } catch (error) {
        if (isChatCancellation(error)) throw error;
        assertActive();
        setFailedSends((previous) => new Map(previous).set(optimisticId, { content, files: renderFiles }));
        throw error;
      } finally {
        try { assertActive(); composerRef.current?.focus(); } catch {}
      }
    },
  });
  const sendPending = () => workspaceOwner.queryClient.isMutating({ mutationKey: sendKey, exact: true }) > 0;
  const handleSend = () => {
    const original = captureChatIntent(workspaceOwner, chatActions.view);
    assertChatIntent(original);
    const conversation = chatActions.readConversation(), rawInput = readInput(), files = readPendingFiles(), skill = readActiveSkill();
    if (sendPending() || !conversation || !rawInput.trim() && !files.length) return;
    if (!rawInput.trim()) { toast.error("Please type a message"); return; }
    sendCommand.mutate({ original, conversation, content: skill ? `/${skill.name} ${rawInput.trim()}` : rawInput.trim(), files, quote: readQuotedMessage(), rawInput, skillName: skill?.name });
  };
  const handleRetrySend = (messageId: string) => {
    const original = captureChatIntent(workspaceOwner, chatActions.view);
    assertChatIntent(original);
    const conversation = chatActions.readConversation(), failed = failedSends.get(messageId);
    if (sendPending() || !conversation || !failed) return;
    sendCommand.mutate({ original, conversation, content: failed.content, files: failed.files, quote: null, retryId: messageId });
  };

  const sessionCommandKey = useMemo(() => workspaceOwner.key("chat", "session-command", crypto.randomUUID()), [workspaceOwner]);
  type SessionIntent = { original: ReturnType<typeof captureChatIntent>; conversation: Conversation; channel: string; agentName: string } & ({ kind: "nap" } | { kind: "retry"; taskId: string });
  const sessionCommand = useMutation({ mutationKey: sessionCommandKey, gcTime: 0, scope: { id: JSON.stringify(sessionCommandKey) },
    mutationFn: async (intent: SessionIntent) => {
      assertChatIntent(intent.original);
      if (intent.kind === "retry") {
        const tickets = captureChatLoad(workspaceOwner);
        const newTask = await runChatIntentRequest(intent.original, (options) => retryTaskApi(intent.taskId, workspaceId, options));
        assertChatIntent(intent.original);
        const key = workspaceOwner.key("chat", "task", newTask.id), ticket = tickets.get(JSON.stringify(key))?.receipt;
        if (ticket ? isQueryReceiptCurrent(ticket) : !workspaceOwner.queryClient.getQueryCache().find({ queryKey: key, exact: true })) workspaceOwner.queryClient.setQueryData(key, newTask);
        setActiveTask(workspaceOwner.queryClient.getQueryData<Task>(key) ?? null);
        startPolling(newTask.id, intent.conversation.id);
        return;
      }
      pollState.setState(() => ({ target: null }));
      const newConv = await runChatIntentRequest(intent.original, (options) => createConversationApi(agentId, workspaceId, intent.channel, options));
      assertChatIntent(intent.original);
      setNapMarkers((rows) => [...rows, { agentName: intent.agentName, created_at: newConv.created_at, id: `nap-${intent.conversation.id}` }]);
      setPreviousConversations((rows) => [{ id: intent.conversation.id, created_at: intent.conversation.created_at }, ...rows]);
      setConversation(newConv); setActiveTask(null);  setPendingFiles([]);
      setPendingFilesByMessage((rows) => { for (const files of rows.values()) for (const file of files) if (file.thumbnailUrl) URL.revokeObjectURL(file.thumbnailUrl); return new Map(); });
      setFailedSends(new Map()); setStableKeyMap(new Map());
      protocol.setState((state) => ({ ...state, lastSeq: 0, pollFailures: 0, oldestCursor: null }));
      setHasMore(false); scrollToBottom();
    },
  });
  const napping = useIsMutating({ mutationKey: sessionCommandKey, exact: true, predicate: (mutation) => (mutation.state.variables as SessionIntent).kind === "nap" }) > 0;
  const sessionPending = () => workspaceOwner.queryClient.isMutating({ mutationKey: sessionCommandKey, exact: true }) > 0;
  const handleRetryTask = async () => {
    const original = captureChatIntent(workspaceOwner, chatActions.view); assertChatIntent(original);
    const conversation = chatActions.readConversation(), taskId = chatActions.readActiveTaskId();
    if (!conversation || !taskId || sessionPending()) return;
    try { await sessionCommand.mutateAsync({ original, conversation, kind: "retry", taskId, channel: readActiveChannel(), agentName: readAgentName() }); }
    catch (error) { try { assertChatIntent(original); } catch { return; } if (!isChatCancellation(error)) toast.error("Failed to retry the task"); }
  };

  const currentConvHasMessages = useMemo(
    () =>
      !!conversation &&
      messages.some((m) => m.conversation_id === conversation.id),
    [conversation, messages],
  );

  const handleNap = async () => {
    const original = captureChatIntent(workspaceOwner, chatActions.view); assertChatIntent(original);
    const conversation = chatActions.readConversation();
    if (!conversation || !chatActions.readMessages().some((row) => row.conversation_id === conversation.id) || sessionPending()) return;
    try { await sessionCommand.mutateAsync({ original, conversation, kind: "nap", channel: readActiveChannel(), agentName: readAgentName() }); }
    catch (error) { try { assertChatIntent(original); } catch { return; } if (!isChatCancellation(error)) toast.error("Failed to start new conversation"); }
  };

  return {
    chatView: chatActions.view,
    readConversation: chatActions.readConversation,
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
    stableKeyMap,
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
