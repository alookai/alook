import { captureQueryReceipt, isQueryReceiptCurrent, withQueryReceipt, reconcileQueryReceipt } from "@/lib/query-receipt"
import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { listMessages, listMessagesAroundTask, listArtifacts, getTask, getTaskMessages, getActiveTask, listPreviousConversations, listFlaggedMessageIds } from "@/lib/api"
import type { TaskApi, TaskMessageResponse } from "@alook/shared"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"
import { chatExtrasKey, chatMessagesKey, mergeCachedMessages, sortedChatMessages, type ChatExtras, type ChatMessagesData, type ChatMessagesPage } from "@/lib/chat-cache"
import type { ChatFlagsData } from "@/lib/workspace-chat-flags"
import { captureChatIntent, assertChatIntent } from "./use-chat-data"

type ChatView = Parameters<typeof captureChatIntent>[1]
export function chatReadSource(owner: WorkspaceOwner, view: ChatView, identity: string, options?: ApiRequestOptions) {
  const intent = captureChatIntent(owner, view)
  const factOrigin = captureWorkspaceOwner(owner)
  const assertFactActive = (signal?: AbortSignal) => assertWorkspaceOwner(factOrigin, signal)
  const assertActive = (signal?: AbortSignal) => { assertChatIntent(intent, signal); assertChatIntent(intent, options?.signal ?? undefined); options?.assertActive?.() }
  assertActive()
  return { owner, view, options, assertActive, assertFactActive, meta: { chatView: view, chatGeneration: intent.generation }, key: (...resource: readonly unknown[]) => owner.key("chat", "io", identity, intent.generation, ...resource), request: (signal: AbortSignal): ApiRequestOptions => workspaceRequestOptions(factOrigin, signal, () => assertFactActive(signal)) }
}
export function chatMessagePageOptions(source: ReturnType<typeof chatReadSource>, conversationId: string, initialPage?: Parameters<typeof listMessages>[2]) {
  const requestRevision = source.owner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(source.owner, conversationId))?.liveRevision ?? 0
  return infiniteQueryOptions({ queryKey: chatMessagesKey(source.owner, conversationId), meta: source.meta, retry: false, staleTime: 0,
    initialPageParam: initialPage ?? null,
    getNextPageParam: (lastPage: ChatMessagesPage) => {
      const oldest = lastPage.messages[0]
      return lastPage.hasMore && oldest ? { limit: 20, before: oldest.created_at, beforeId: oldest.id } : undefined
    },
    queryFn: async ({ signal, pageParam }) => {
      const result = await listMessages(conversationId, source.owner.workspaceId, pageParam ?? undefined, source.request(signal))
      source.assertFactActive(signal)
      return { messages: result.messages, hasMore: result.has_more, requestRevision } satisfies ChatMessagesPage
    },

  })
}
export function chatAroundTaskOptions(source: ReturnType<typeof chatReadSource>, conversationId: string, taskId: string) {
  return queryOptions({ queryKey: source.key("around-task", conversationId, taskId), retry: false, gcTime: 0, staleTime: 0,
    queryFn: async ({ signal }) => {
      const key = chatMessagesKey(source.owner, conversationId), receipt = captureQueryReceipt(source.owner.queryClient, key);
      const revision = source.owner.queryClient.getQueryData<ChatMessagesData>(key)?.liveRevision ?? 0;
      const messages = await listMessagesAroundTask(conversationId, source.owner.workspaceId, taskId, { ...source.request(signal), assertActive: () => source.assertActive(signal) })
      source.assertActive(signal)
      const current = source.owner.queryClient.getQueryData<ChatMessagesData>(key);
      const sameResource = source.owner.queryClient.getQueryCache().find({ queryKey: key, exact: true }) === receipt.resource;
      if (sameResource || !receipt.resource && (current?.liveRevision ?? 0) > 0) await mergeCachedMessages(conversationId, messages.filter((row) => (current?.liveMessageRevisions?.[row.id] ?? 0) <= revision), null, source.owner);
      source.assertActive(signal)
      return messages.map((row) => row.id)
    },
  })
}
export function readChatMessageIds(source: ReturnType<typeof chatReadSource>, conversationId: string, ids: string[]) {
  source.assertActive()
  const rows = new Map(sortedChatMessages(source.owner.queryClient.getQueryData<ChatMessagesData>(chatMessagesKey(source.owner, conversationId))).map((row) => [row.id, row]))
  return ids.flatMap((id) => { const row = rows.get(id); return row ? [row] : [] })
}
export function chatArtifactOptions(source: ReturnType<typeof chatReadSource>, conversationId: string) {
  return queryOptions({ queryKey: chatExtrasKey(source.owner, conversationId), meta: source.meta, retry: false, staleTime: 0, structuralSharing: reconcileQueryReceipt,
    queryFn: async ({ signal }): Promise<ChatExtras> => {
      const receipt = captureQueryReceipt(source.owner.queryClient, chatExtrasKey(source.owner, conversationId))
      const artifacts = await listArtifacts(conversationId, source.owner.workspaceId, source.request(signal))
      source.assertFactActive(signal)
      const data = source.owner.queryClient.getQueryData<ChatExtras>(chatExtrasKey(source.owner, conversationId))
      return withQueryReceipt({ conversation: data?.conversation ?? null, artifacts, hasMoreArtifacts: false }, receipt, (previous, incoming) => {
        const old = previous as ChatExtras | undefined, next = incoming as ChatExtras
        return { ...next, conversation: old?.conversation ?? next.conversation, artifacts: [...new Map([...next.artifacts, ...(old?.artifacts ?? [])].map((row) => [row.id, row])).values()], hasMoreArtifacts: old?.hasMoreArtifacts ?? next.hasMoreArtifacts }
      })
    },
  })
}
export function chatTaskOptions(source: ReturnType<typeof chatReadSource>, taskId: string) {
  return queryOptions({ queryKey: source.owner.key("chat", "task", taskId), meta: source.meta, retry: false, staleTime: 0, structuralSharing: reconcileQueryReceipt,
    queryFn: async ({ signal }) => {
      const receipt = captureQueryReceipt(source.owner.queryClient, source.owner.key("chat", "task", taskId))
      const task = await getTask(taskId, source.owner.workspaceId, source.request(signal))
      source.assertFactActive(signal)
      return withQueryReceipt(task, receipt)
    },
  })
}
export function readChatTask(source: ReturnType<typeof chatReadSource>, taskId: string) {
  source.assertActive()
  return source.owner.queryClient.getQueryData<TaskApi>(source.owner.key("chat", "task", taskId))!
}
export function chatTaskMessagesOptions(source: ReturnType<typeof chatReadSource>, taskId: string) {
  return queryOptions({ queryKey: source.owner.key("chat", "task-messages", taskId), meta: source.meta, retry: false, staleTime: 0, structuralSharing: reconcileQueryReceipt,
    queryFn: async ({ signal }) => {
      const receipt = captureQueryReceipt(source.owner.queryClient, source.owner.key("chat", "task-messages", taskId))
      const incoming = await getTaskMessages(taskId, source.owner.workspaceId, undefined, source.request(signal))
      source.assertFactActive(signal)
      const data = source.owner.queryClient.getQueryData<TaskMessageResponse[]>(source.owner.key("chat", "task-messages", taskId))
      {
        const rows = new Map((data ?? []).map((row) => [row.seq, row]))
        for (const row of incoming) rows.set(row.seq, row)
        return withQueryReceipt([...rows.values()].sort((a, b) => a.seq - b.seq), receipt, (previous, next) => [...new Map([...(next as TaskMessageResponse[]), ...((previous as TaskMessageResponse[] | undefined) ?? [])].map((row) => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq))
      }
    },
  })
}
export function chatActiveTaskOptions(source: ReturnType<typeof chatReadSource>, conversationId: string) {
  return queryOptions({ queryKey: source.owner.key("chat", "active-task", conversationId), meta: source.meta, retry: false, staleTime: 0, structuralSharing: reconcileQueryReceipt,
    queryFn: async ({ signal }) => {
      const receipt = captureQueryReceipt(source.owner.queryClient, source.owner.key("chat", "active-task", conversationId))
      const tasks = new Map(source.owner.queryClient.getQueryCache().findAll({ queryKey: source.owner.key("chat", "task") }).map((query) => [JSON.stringify(query.queryKey), captureQueryReceipt(source.owner.queryClient, query.queryKey)]))
      const task = await getActiveTask(conversationId, source.owner.workspaceId, source.request(signal))
      source.assertFactActive(signal)
      if (task) {
        const key = source.owner.key("chat", "task", task.id), ticket = tasks.get(JSON.stringify(key))
        if (ticket ? isQueryReceiptCurrent(ticket) : !source.owner.queryClient.getQueryCache().find({ queryKey: key, exact: true })) source.owner.queryClient.setQueryData(key, task)
      }
      return withQueryReceipt({ id: task?.id ?? null }, receipt)
    },
  })
}
export function chatPreviousOptions(source: ReturnType<typeof chatReadSource>, agentId: string, page: Parameters<typeof listPreviousConversations>[2]) {
  return infiniteQueryOptions({ queryKey: source.owner.key("chat", "previous-conversations", agentId, page.channel ?? "", page.exclude), meta: source.meta, retry: false, staleTime: 0,
    initialPageParam: page.before,
    getNextPageParam: (lastPage: { conversations: Array<{ id: string; created_at: string }>; has_more: boolean }) => lastPage.has_more ? lastPage.conversations.at(-1)?.created_at : undefined,
    queryFn: async ({ signal, pageParam }) => {
      const result = await listPreviousConversations(agentId, source.owner.workspaceId, { ...page, before: pageParam }, source.request(signal))
      source.assertFactActive(signal)
      return result
    },
  })
}
export function chatFlagsOptions(source: ReturnType<typeof chatReadSource>, conversationId: string) {
  const requestRevision = source.owner.queryClient.getQueryData<ChatFlagsData>(source.owner.key("chat", "flags", conversationId))?.revision ?? 0
  return queryOptions({ queryKey: source.owner.key("chat", "flags", conversationId), meta: source.meta, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => { const data = await listFlaggedMessageIds(source.owner.workspaceId, conversationId, source.request(signal)); source.assertFactActive(signal); return { ids: data.message_ids, requestRevision } satisfies ChatFlagsData },
  })
}

export function observeChatRead(source: ReturnType<typeof chatReadSource>, observer: { subscribe: (listener: () => void) => () => void; destroy: () => void }) {
  source.assertActive()
  const unsubscribe = observer.subscribe(() => {})
  let released = false
  const release = () => {
    if (released) return
    released = true
    subscription.unsubscribe()
    source.options?.signal?.removeEventListener("abort", release)
    unsubscribe()
    observer.destroy()
  }
  const subscription = source.view.subscribe(() => { try { source.assertActive() } catch { release() } })
  source.options?.signal?.addEventListener("abort", release, { once: true })
  return release
}
