"use client"

import { useCallback, useMemo, useLayoutEffect } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useQueries, useQuery, skipToken, type InfiniteData, type UseQueryResult } from "@tanstack/react-query"
import type { Conversation, Message, Artifact, TaskApi, TaskMessageResponse } from "@alook/shared"
import type { PreviousConversation } from "@/lib/api"
import type { Store } from "@tanstack/react-store"
import type { WorkspaceOwner } from "@/contexts/workspace-context"
import { assertWorkspaceOwner, captureWorkspaceOwner, workspaceRequestOptions } from "@/contexts/workspace-context"
import type { ApiRequestOptions } from "@/lib/api/client"
import { chatMessagesKey, chatExtrasKey, sortedChatMessages, type ChatMessagesData, type ChatExtras } from "@/lib/chat-cache"

const combineChatQueryData = (results: UseQueryResult[]) => results.map((result) => result.data as ChatMessagesData | undefined)

export function useChatData(owner: WorkspaceOwner, identity: string, targetConversationId: string | null) {
  const view = useMemo(() => createStore({
    owner, identity, active: true, generation: 0,
    conversationId: targetConversationId, frontierId: targetConversationId,
    window: [] as Array<{ conversationId: string; id: string }>,
    optimistic: new Map<string, Message>(), selectedTaskId: undefined as string | null | undefined,
    previousKey: null as readonly unknown[] | null, previousIds: [] as string[], previousHint: false,
  }), [owner, identity, targetConversationId])
  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active: true }))
    return () => {
      view.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
      void owner.queryClient.cancelQueries({ queryKey: owner.key("chat", "open", identity) })
      void owner.queryClient.cancelQueries({ queryKey: owner.key("chat", "io", identity) })
    }
  }, [identity, owner, view])
  const conversationId = useSelector(view, (state) => state.conversationId)
  const frontierId = useSelector(view, (state) => state.frontierId)
  const refs = useSelector(view, (state) => state.window)
  const optimistic = useSelector(view, (state) => state.optimistic)
  const conversationIds = useMemo(() => [...new Set(refs.map((row) => row.conversationId))], [refs])
  const messageQueries = useQueries({ queries: conversationIds.map((id) => ({ queryKey: chatMessagesKey(owner, id), queryFn: skipToken, enabled: false })), combine: combineChatQueryData })
  const messages = useMemo(() => {
    const rows = new Map<string, Message>()
    for (let i = 0; i < conversationIds.length; i++) {
      for (const row of sortedChatMessages(messageQueries[i])) rows.set(`${row.conversation_id}:${row.id}`, row)
    }
    return refs.flatMap((ref) => {
      const row = optimistic.get(ref.id) ?? rows.get(`${ref.conversationId}:${ref.id}`)
      return row ? [row] : []
    })
  }, [conversationIds, messageQueries, optimistic, refs])
  const extrasKey = chatExtrasKey(owner, conversationId ?? "__none__")
  const extras = useQuery<ChatExtras>({ queryKey: extrasKey, queryFn: skipToken, enabled: false }).data
  const taskKey = owner.key("chat", "active-task", conversationId ?? "__none__")
  const canonicalTaskId = useQuery<{ id: string | null }>({ queryKey: taskKey, queryFn: skipToken, enabled: false }).data?.id
  const selectedTaskId = useSelector(view, (state) => state.selectedTaskId)
  const activeTaskId = selectedTaskId === undefined ? canonicalTaskId : selectedTaskId
  const activeTask = useQuery<TaskApi>({ queryKey: owner.key("chat", "task", activeTaskId ?? "__none__"), queryFn: skipToken, enabled: false }).data ?? null
  const taskMessagesKey = owner.key("chat", "task-messages", activeTask?.id ?? "__none__")
  const taskMessages = useQuery<TaskMessageResponse[]>({ queryKey: taskMessagesKey, queryFn: skipToken, enabled: false }).data ?? EMPTY_TASK_MESSAGES
  const currentMessages = useQuery<ChatMessagesData>({ queryKey: chatMessagesKey(owner, frontierId ?? "__none__"), queryFn: skipToken, enabled: false }).data
  const previousKey = useSelector(view, (state) => state.previousKey)
  const previousIds = useSelector(view, (state) => state.previousIds)
  const previousHint = useSelector(view, (state) => state.previousHint)
  const previous = useQuery<InfiniteData<{ conversations: PreviousConversation[]; has_more: boolean }>>({ queryKey: previousKey ?? owner.key("chat", "previous-conversations", "__none__"), queryFn: skipToken, enabled: false }).data
  const readPrevious = useCallback(() => {
    const state = view.get()
    const data = state.previousKey ? owner.queryClient.getQueryData<InfiniteData<{ conversations: PreviousConversation[]; has_more: boolean }>>(state.previousKey) : undefined
    const rows = new Map((data?.pages ?? []).flatMap((page) => page.conversations).map((row) => [row.id, row]))
    return state.previousIds.flatMap((id) => {
      const row = rows.get(id)
      if (row) return [row]
      const conversation = owner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(owner, id))?.conversation
      return conversation ? [{ id, created_at: conversation.created_at }] : []
    })
  }, [owner, view])
  const previousConversations = useMemo(() => {
    const rows = new Map((previous?.pages ?? []).flatMap((page) => page.conversations).map((row) => [row.id, row]))
    return previousIds.flatMap((id) => {
      const row = rows.get(id)
      if (row) return [row]
      const conversation = owner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(owner, id))?.conversation
      return conversation ? [{ id, created_at: conversation.created_at }] : []
    })
  }, [owner, previous, previousIds])
  const assertCurrent = useCallback(() => {
    assertWorkspaceOwner(captureWorkspaceOwner(owner))
    if (!view.get().active) throw new DOMException("Retired chat view", "AbortError")
  }, [owner, view])
  const readMessages = useCallback(() => {
    const state = view.get()
    const all = new Map<string, Message>()
    for (const id of new Set(state.window.map((ref) => ref.conversationId))) {
      for (const row of sortedChatMessages(owner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(owner, id)))) all.set(`${id}:${row.id}`, row)
    }
    return state.window.flatMap((ref) => {
      const row = state.optimistic.get(ref.id) ?? all.get(`${ref.conversationId}:${ref.id}`)
      return row ? [row] : []
    })
  }, [owner, view])
  const setMessages = useCallback((update: Message[] | ((rows: Message[]) => Message[])) => {
    assertCurrent()
    const next = typeof update === "function" ? update(readMessages()) : update
    const drafts = new Map<string, Message>()
    for (const row of next) {
      if (row.id.startsWith("temp-")) { drafts.set(row.id, row); continue }
    }
    view.setState((state) => ({ ...state, window: next.map((row) => ({ conversationId: row.conversation_id, id: row.id })), optimistic: drafts }))
  }, [assertCurrent, readMessages, view])
  const selectConversation = useCallback((conversationId: string) => {
    assertCurrent()
    view.setState((state) => ({ ...state, conversationId, frontierId: conversationId, selectedTaskId: state.conversationId === conversationId ? state.selectedTaskId : undefined }))
  }, [assertCurrent, view])
  const setConversation = useCallback((update: Conversation | null | ((row: Conversation | null) => Conversation | null)) => {
    assertCurrent()
    const id = view.get().conversationId
    const old = id ? owner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(owner, id))?.conversation ?? null : null
    const next = typeof update === "function" ? update(old) : update
    if (next && !owner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(owner, next.id))?.conversation) owner.queryClient.setQueryData<ChatExtras>(chatExtrasKey(owner, next.id), (data) => ({ conversation: next, artifacts: data?.artifacts ?? [], hasMoreArtifacts: data?.hasMoreArtifacts ?? false }))
    view.setState((state) => ({ ...state, conversationId: next?.id ?? null, frontierId: next?.id ?? null, selectedTaskId: state.conversationId === next?.id ? state.selectedTaskId : undefined }))
  }, [assertCurrent, owner, view])
  const setActiveTask = useCallback((update: TaskApi | null | ((task: TaskApi | null) => TaskApi | null)) => {
    assertCurrent()
    const state = view.get(), id = state.conversationId
    if (!id) return
    const oldId = state.selectedTaskId === undefined ? owner.queryClient.getQueryData<{ id: string | null }>(owner.key("chat", "active-task", id))?.id : state.selectedTaskId
    const old = oldId ? owner.queryClient.getQueryData<TaskApi>(owner.key("chat", "task", oldId)) ?? null : null
    const next = typeof update === "function" ? update(old) : update
    view.setState((state) => ({ ...state, selectedTaskId: next?.id ?? null }))
  }, [assertCurrent, owner, view])
  const setHasMore = useCallback((hasMore: boolean, frontierId?: string) => {
    assertCurrent()
    const id = frontierId ?? view.get().frontierId ?? view.get().conversationId
    if (!id) return
    view.setState((state) => ({ ...state, frontierId: id }))
    if (!owner.queryClient.getQueryData(chatMessagesKey(owner, id))) owner.queryClient.setQueryData<ChatMessagesData>(chatMessagesKey(owner, id), { pages: [{ messages: [], hasMore }], pageParams: [null], serverMessageCount: 0 })
  }, [assertCurrent, owner, view])
  const selectPreviousResource = useCallback((key: readonly unknown[]) => {
    assertCurrent()
    view.setState((state) => ({ ...state, previousKey: key }))
  }, [assertCurrent, view])
  const setPreviousConversations = useCallback((update: PreviousConversation[] | ((rows: PreviousConversation[]) => PreviousConversation[])) => {
    assertCurrent()
    const rows = typeof update === "function" ? update(readPrevious()) : update
    view.setState((state) => ({ ...state, previousIds: rows.map((row) => row.id), previousKey: rows.length ? state.previousKey : null }))
  }, [assertCurrent, readPrevious, view])
  const setHasMoreConversations = useCallback((hasMore: boolean) => {
    assertCurrent()
    view.setState((state) => ({ ...state, previousHint: hasMore }))
  }, [assertCurrent, view])
  const firstFrontierId = refs.find((row) => row.conversationId === frontierId)?.id
  const frontierRows = sortedChatMessages(currentMessages)
  const hasMore = currentMessages?.pages.at(-1)?.hasMore === true || (firstFrontierId ? frontierRows.findIndex((row) => row.id === firstFrontierId) > 0 : frontierRows.length > 0)
  const actions = useMemo(() => {
  const readHasMore = () => {
    const state = view.get(), data = owner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(owner, state.frontierId ?? "__none__"))
    const first = state.window.find((row) => row.conversationId === state.frontierId)?.id, rows = sortedChatMessages(data)
    return data?.pages.at(-1)?.hasMore === true || (first ? rows.findIndex((row) => row.id === first) > 0 : rows.length > 0)
  }
  const readHasMoreConversations = () => {
    const state = view.get(), data = state.previousKey ? owner.queryClient.getQueryData<InfiniteData<{ conversations: PreviousConversation[]; has_more: boolean }>>(state.previousKey) : undefined
    return data?.pages.at(-1)?.has_more ?? state.previousHint
  }
  const readActiveTaskId = () => { const state = view.get(), id = state.conversationId; return state.selectedTaskId !== undefined ? state.selectedTaskId : id ? owner.queryClient.getQueryData<{ id: string | null }>(owner.key("chat", "active-task", id))?.id ?? null : null }
  const readConversation = () => { const id = view.get().conversationId; return id ? owner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(owner, id))?.conversation ?? null : null }
    return { view, readMessages, readPrevious, selectConversation, selectPreviousResource, setHasMore, setPreviousConversations, setHasMoreConversations, setMessages, setConversation, setActiveTask, readHasMore, readHasMoreConversations, readActiveTaskId, readConversation }
  }, [owner, view, readMessages, readPrevious, selectConversation, selectPreviousResource, setHasMore, setPreviousConversations, setHasMoreConversations, setMessages, setConversation, setActiveTask])
  return { actions, ...actions, readMessages, readPrevious, selectConversation, selectPreviousResource, hasMore, setHasMore, previousConversations, hasMoreConversations: previous?.pages.at(-1)?.has_more ?? previousHint, setPreviousConversations, setHasMoreConversations, conversation: extras?.conversation ?? null, messages, artifacts: extras?.artifacts ?? EMPTY_ARTIFACTS, activeTask, taskMessages, setMessages, setConversation, setActiveTask }
}
const EMPTY_TASK_MESSAGES: TaskMessageResponse[] = []
const EMPTY_ARTIFACTS: Artifact[] = []

export function captureChatIntent(owner: WorkspaceOwner, view: Pick<Store<{ active: boolean; generation: number }>, "get" | "subscribe">) {
  return { workspace: captureWorkspaceOwner(owner), view, generation: view.get().generation }
}
export function assertChatIntent(token: ReturnType<typeof captureChatIntent>, signal?: AbortSignal) {
  assertWorkspaceOwner(token.workspace, signal)
  if (!token.view.get().active || token.view.get().generation !== token.generation) throw new DOMException("Retired chat intent", "AbortError")
}

export async function runChatIntentRequest<T>(intent: ReturnType<typeof captureChatIntent>, operation: (options: ApiRequestOptions) => Promise<T>) {
  const controller = new AbortController()
  const assertActive = () => assertChatIntent(intent, controller.signal)
  assertActive()
  const changed = () => { try { assertActive() } catch { controller.abort() } }
  const subscriptions = [intent.view, intent.workspace.owner.lifecycle, intent.workspace.owner.application.lifecycle].map((store) => store.subscribe(changed))
  try {
    const result = await operation(workspaceRequestOptions(intent.workspace, controller.signal, assertActive))
    assertActive()
    return result
  } catch (error) { assertActive(); throw error }
  finally { for (const subscription of subscriptions) subscription.unsubscribe() }
}
