"use client"

import { useCallback } from "react"
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { isInlineAttachmentContentType } from "@/lib/community/attachment-content-type"
import { formatAttachmentSize } from "@/lib/community/attachment-presentation"
import { attachmentThumbnailUrl, attachmentUrl } from "@/lib/community/storage"
import {
  projectPostedMessage,
  type PostedMessage,
} from "@/lib/community/message-wire"
import { useCommunityStore } from "@/stores/community"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { getMessageOverlay } from "@/stores/community/message-stream"
import {
  materializeMessageStream,
  type CanonicalMessage,
  type MessageScope,
} from "@/lib/community/message-stream"
import type { Attachment, MessagesPage, Msg } from "@/lib/community/models/message"
import type { PinsResponse } from "@/hooks/community/use-channel-panels"
import type {
  MarkedResponse,
  MentionsResponse,
  MessageMarkedResponse,
} from "@/hooks/community/use-inbox"
import {
  getForumSidebarBase,
  hasForumSidebarThread,
  invalidateForumSidebarBaseExact,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
} from "@/hooks/community/use-forum-sidebar-threads"
import { reconcileForumOpenerTitle } from "@/hooks/community/forum-opener-title-reconciliation"
import { isBlocked, type MentionType } from "@alook/shared"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadDismissToken,
  type AccountUnreadDomain,
  type MarkAllToken,
} from "@/hooks/community/account-unread-projection"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"


/**
 * Message-scoped mutation hooks — the split of the God-context's
 * `sendMessage`/`toggleReaction`/`pinMessage`/etc. into standalone
 * `useMutation` hooks. Message existence is owned by the session overlay;
 * field-only operations and panel resources may still patch TanStack Query.
 * Each hook performs its fetch inside `mutationFn` and applies the matching
 * reducer/cache terminal transition on success or failure.
 *
 * Rules of engagement:
 * - Never invalidate on success unless there's no server-broadcast path — the
 *   WS handler already patches the cache. Over-invalidating causes a
 *   double-fetch (WS invalidate then success invalidate).
 * - Reads from cache via `queryClient.getQueryData` for the pre-mutation
 *   snapshot, never from parent-supplied props — snapshots must be captured
 *   at the same instant they're written back on rollback.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

type PageCache = InfiniteData<MessagesPage>

function patchContentById(cache: PageCache | undefined, id: string, content: string): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((page) => ({
    ...page,
    messages: page.messages.map((message) => {
      if (message.id !== id) return message
      touched = true
      return { ...message, content }
    }),
  }))
  return touched ? { ...cache, pages } : cache
}

type EditMessageArgs = {
  serverId: string
  channelId: string
  messageId: string
  content: string
  forumChannelId?: string
  forumThreadId?: string
}

type EditMessageContext = {
  previous: PageCache | undefined
  previousContent: string | undefined
  key: readonly unknown[]
  scope: MessageScope
  previousMessage: { content: string } | undefined
  messageKey: readonly unknown[]
}

export function useEditMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, EditMessageArgs, EditMessageContext>({
    mutationFn: async ({ messageId, content }) => {
      await apiFetch(`/api/community/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      })
    },
    onMutate: async ({ serverId, channelId, messageId, content }) => {
      const key = communityKeys.channelMessages(channelId)
      const scope: MessageScope = { kind: "channel", id: channelId, serverId }
      const messageKey = communityKeys.message(messageId)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: key }),
        queryClient.cancelQueries({ queryKey: messageKey }),
      ])
      const previous = queryClient.getQueryData<PageCache>(key)
      const previousMessage = queryClient.getQueryData<{ content: string }>(messageKey)
      const previousContent = currentMaterializedMessage(previous, scope, messageId)?.content
      queryClient.setQueryData<PageCache>(key, (cache) => patchContentById(cache, messageId, content))
      queryClient.setQueryData<{ content: string }>(messageKey, (message) => message ? { ...message, content } : message)
      useMessageStreamStore.getState().dispatch(scope, {
        type: "messageEdited",
        messageId,
        content,
      })
      return { previous, previousContent, key, scope, previousMessage, messageKey }
    },
    onError: (_error, _variables, context) => {
      if (!context) return
      queryClient.setQueryData(context.key, context.previous)
      if (context.previousContent !== undefined) {
        useMessageStreamStore.getState().dispatch(context.scope, {
          type: "messageEdited",
          messageId: _variables.messageId,
          content: context.previousContent,
        })
      }
      queryClient.setQueryData(context.messageKey, context.previousMessage)
    },
    onSuccess: async (_data, variables) => {
      if (!variables.forumChannelId || !variables.forumThreadId) return
      await reconcileForumOpenerTitle(queryClient, {
        serverId: variables.serverId,
        forumChannelId: variables.forumChannelId,
        childChannelId: variables.forumThreadId,
        openerMessageId: variables.messageId,
        content: variables.content,
      })
    },
  })
}

/**
 * Materialize the attachment view-model from the API attachment shape.
 * Mirrors the old context's conversion at `postWithOptimisticInsert`.
 * Exported for direct unit testing — see `to-attachment-vm.test.ts`.
 */
export function toAttachmentVm(
  channelId: string,
  a: { id: string; filename: string; contentType: string; size: number; hasThumbnail?: boolean; width?: number; height?: number },
): Attachment {
  // Reserve-by-id (route/disc step 2b): the server no longer returns a `url` for
  // a fresh upload — it returns the attachment `id`. The display URL is
  // id-addressed (the canonical `channels/{id}/attachments/{attachmentId}` door)
  // and derived HERE client-side, matching what the server's read path emits via
  // `attachmentUrl`. This keeps the optimistic row's image src identical to the
  // reconciled row that arrives over WS.
  const url = attachmentUrl(channelId, a.id)
  const isImage = isInlineAttachmentContentType(a.contentType)
  if (isImage) return {
    kind: "image",
    name: a.filename,
    url,
    contentType: a.contentType,
    sizeBytes: a.size,
    ...(a.hasThumbnail ? { thumbnailUrl: attachmentThumbnailUrl(channelId, a.id) } : {}),
    width: a.width,
    height: a.height,
  }
  return {
    kind: "file",
    name: a.filename,
    url,
    contentType: a.contentType,
    sizeBytes: a.size,
    size: formatAttachmentSize(a.size),
  }
}

// Random-ish temp id — collision on the same tick is essentially impossible
// with the second-tier `Math.random` mixin.
export function tempMessageId(): string {
  return `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

// Idempotency nonce (mutation-idempotency plan). Generated ONCE per logical
// send and REUSED verbatim on every retry-pill resend — the retry caller
// passes the failed row's `clientNonce` back in via `SendMessageArgs.nonce`,
// so a 500-after-commit resend matches the already-committed message
// server-side (returns `deduped: true`) instead of double-posting. A fresh
// send with no nonce supplied mints a new random one. `crypto.randomUUID` is
// available in every browser this app targets.
export function sendNonce(): string {
  return crypto.randomUUID()
}

// ── Send message (channel/thread) ──────────────────────────────────────────

export type SendMessageArgs = {
  serverId: string
  channelId: string
  forumParentChannelId?: string
  content: string
  replyToId?: string
  replyTo?: Msg["replyTo"]
  mentionType?: MentionType
  // Reserve-by-id: pre-uploaded pending-attachment descriptors. Only `id` is
  // sent to the server (in an id array); the rest drive the optimistic VM
  // (whose url is derived client-side from `id`). No `url` field — the upload
  // no longer returns one.
  attachments?: { id: string; filename: string; contentType: string; size: number; hasThumbnail?: boolean; width?: number; height?: number }[]
  author: { id: string; name: string; avatar: string }
  // Idempotency nonce. Omitted on a fresh send (the hook mints one); the
  // retry-pill caller passes the failed row's nonce back so the resend reuses
  // it and dedupes server-side instead of double-posting.
  nonce?: string
}

// `deduped: true` means this POST matched an already-committed send carrying
// the same nonce — `message` is the canonical (original) row, nothing new was
// inserted. The caller treats it as success (reconcile the optimistic row,
// clear the failed pill), never as a failure to resend.
export type SendMessageResult = { message: PostedMessage; deduped?: boolean }

/**
 * Channel/thread send. The server infers thread-vs-channel routing from the
 * channel row's `parentChannelId` (per #14), so the client always POSTs to
 * `/channels/:id/messages`.
 */
export function useSendMessage() {
  const queryClient = useQueryClient()
  return useMutation<
    SendMessageResult,
    Error,
    SendMessageArgs
  >({
    mutationFn: async ({ channelId, content, replyToId, replyTo, mentionType, attachments, nonce }) => {
      // Server receives only the attachment IDS (reserve-by-id); the rest of the
      // descriptor is client-only (optimistic VM). Dimensions already rode the
      // upload, so they are NOT re-sent here (single-source guard).
      const attachmentIds = attachments?.map((a) => a.id)
      return apiFetch<SendMessageResult>(
        `/api/community/channels/${channelId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            replyToId: replyTo?.id ?? replyToId,
            mentionType,
            attachments: attachmentIds,
            nonce,
          }),
        },
      )
    },
    onError: (err, args) => {
      if (args.nonce) {
        useMessageStreamStore.getState().dispatch(
          { kind: "channel", id: args.channelId, serverId: args.serverId },
          { type: "postFail", nonce: args.nonce },
        )
      }
      // 429: server-side rate limit. Fire an explicit toast so the user
      // knows why the send failed — otherwise the only signal is a
      // `failed: true` pill, which reads like a generic error. The row
      // still gets marked failed so the retry affordance stays available.
      if (err instanceof ApiError && err.status === 429) {
        toast.error("Rate limited — please wait a moment before trying again")
      } else {
        // Any other failure (validation error, forbidden, 500, etc.) — the
        // `failed: true` pill below is a retry affordance, not a reason.
        // Without this the user sees no explanation at all for send
        // failures outside the 429 case.
        toastApiError(err, "Failed to send message")
      }
    },
    onSuccess: (data, args) => {
      if (
        args.forumParentChannelId &&
        isForumSidebarParent(queryClient, args.serverId, args.forumParentChannelId)
      ) {
        const canonical = hasForumSidebarThread(
          getForumSidebarBase(queryClient, args.serverId),
          args.channelId,
        )
        patchForumSidebarActivityExact(
          queryClient,
          args.serverId,
          args.channelId,
          args.forumParentChannelId,
          data.message.createdAt,
        )
        if (!canonical) {
          void invalidateForumSidebarBaseExact(queryClient, args.serverId)
        }
      }
      if (!args.nonce) return
      useMessageStreamStore.getState().dispatch(
        { kind: "channel", id: args.channelId, serverId: args.serverId },
        {
          type: "postAck",
          nonce: args.nonce,
          message: projectPostedMessage(data.message, args.nonce),
        },
      )
    },
  })
}

// ── Send DM message ────────────────────────────────────────────────────────

export type SendDmMessageArgs = {
  dmId: string
  content: string
  replyToId?: string
  replyTo?: Msg["replyTo"]
  // Reserve-by-id (see SendMessageArgs.attachments): id-bearing descriptors;
  // only `id` reaches the server.
  attachments?: { id: string; filename: string; contentType: string; size: number; width?: number; height?: number }[]
  nonce: string
}

export function useSendDmMessage() {
  return useMutation<
    SendMessageResult,
    Error,
    SendDmMessageArgs
  >({
    mutationFn: async ({ dmId, content, replyToId, replyTo, attachments, nonce }) => {
      const attachmentIds = attachments?.map((a) => a.id)
      return apiFetch<SendMessageResult>(
        `/api/community/channels/${dmId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            replyToId: replyTo?.id ?? replyToId,
            attachments: attachmentIds,
            nonce,
          }),
        },
      )
    },
    onError: (err, args) => {
      const scope = { kind: "dm" as const, id: args.dmId }
      if (err instanceof ApiError && err.status === 403 && isBlocked(err.message)) {
        useMessageStreamStore.getState().dispatch(scope, {
          type: "terminalReject",
          nonce: args.nonce,
        })
        toast("You cannot send messages to this user")
        return
      }
      useMessageStreamStore.getState().dispatch(scope, {
        type: "postFail",
        nonce: args.nonce,
      })
      if (err instanceof ApiError && err.status === 429) {
        toast.error("Rate limited — please wait a moment before trying again")
      } else {
        toastApiError(err, "Failed to send message")
      }
    },
    onSuccess: (data, args) => {
      useMessageStreamStore.getState().dispatch(
        { kind: "dm", id: args.dmId },
        {
          type: "postAck",
          nonce: args.nonce,
          message: projectPostedMessage(data.message, args.nonce),
        },
      )
    },
  })
}

// ── Toggle reaction ────────────────────────────────────────────────────────

export type ToggleReactionArgs = {
  serverId?: string
  channelId?: string
  dmId?: string
  messageId: string
  emoji: string
  userId: string
}

// Apply an optimistic reaction toggle to any page cache that contains the
// message. This mirrors the reducer in the God-context.
function togglePageCacheReaction(
  cache: PageCache | undefined,
  messageId: string,
  emoji: string,
  userId: string,
  add: boolean,
): PageCache | undefined {
  if (!cache) return cache
  let touched = false
  const pages = cache.pages.map((p) => {
    if (!p.messages.some((m) => m.id === messageId)) return p
    touched = true
    const nextMessages = p.messages.map((m) =>
      m.id === messageId ? toggleMessageReaction(m, emoji, userId, add) : m)
    return { ...p, messages: nextMessages }
  })
  if (!touched) return cache
  return { ...cache, pages }
}

function toggledReactions(
  reactionsSource: Msg["reactions"],
  emoji: string,
  userId: string,
  add: boolean,
): NonNullable<Msg["reactions"]> {
  const reactions = (reactionsSource ?? []).map((reaction) => ({
    ...reaction,
    userIds: [...(reaction.userIds ?? [])],
  }))
  const existing = reactions.find((reaction) => reaction.emoji === emoji)
  if (add) {
    if (existing) {
      if (!existing.userIds.includes(userId)) existing.userIds.push(userId)
      existing.count = existing.userIds.length
      existing.me = true
    } else {
      reactions.push({ emoji, count: 1, me: true, userIds: [userId] })
    }
  } else if (existing) {
    existing.userIds = existing.userIds.filter((id) => id !== userId)
    existing.count = existing.userIds.length
    existing.me = false
    if (existing.count <= 0) reactions.splice(reactions.indexOf(existing), 1)
  }
  return reactions
}

function toggleMessageReaction(
  message: Msg,
  emoji: string,
  userId: string,
  add: boolean,
): Msg {
  return { ...message, reactions: toggledReactions(message.reactions, emoji, userId, add) }
}

function toggleSingleMessageReaction<T extends { reactions?: Msg["reactions"] }>(
  message: T | undefined,
  emoji: string,
  userId: string,
  add: boolean,
): T | undefined {
  return message
    ? { ...message, reactions: toggledReactions(message.reactions, emoji, userId, add) }
    : message
}

function messageScope(args: ToggleReactionArgs): MessageScope | undefined {
  if (args.channelId && args.serverId) {
    return { kind: "channel", id: args.channelId, serverId: args.serverId }
  }
  return args.dmId ? { kind: "dm", id: args.dmId } : undefined
}

function currentMaterializedMessage(
  cache: PageCache | undefined,
  scope: MessageScope,
  messageId: string,
): Msg | undefined {
  const base = cache?.pages.flatMap((page) => page.messages)
    .filter((message): message is CanonicalMessage => message.seq !== undefined) ?? []
  return materializeMessageStream(base, getMessageOverlay(scope))
    .find((message) => message.id === messageId)
}

function refreshExistingReactionFallback(
  cache: PageCache | undefined,
  args: ToggleReactionArgs,
  add: boolean,
): void {
  const scope = messageScope(args)
  if (!scope) return
  const overlay = getMessageOverlay(scope)
  const existing = [...overlay.liveById.values()].find((message) => message.id === args.messageId)
  if (!existing) return
  const source = currentMaterializedMessage(cache, scope, args.messageId) ?? existing
  if (source.seq === undefined) return
  useMessageStreamStore.getState().dispatch(scope, {
    type: "liveRefreshed",
    message: toggleMessageReaction(source, args.emoji, args.userId, add) as CanonicalMessage,
  })
}

function currentMeStatus(
  cache: PageCache | undefined,
  messageId: string,
  emoji: string,
): boolean {
  if (!cache) return false
  for (const p of cache.pages) {
    const msg = p.messages.find((m) => m.id === messageId)
    if (!msg) continue
    return msg.reactions?.find((r) => r.emoji === emoji)?.me ?? false
  }
  return false
}

// #9: 300ms coalescing window. A user tapping the same reaction pill in rapid
// succession should collapse to one API call whose verb matches the final
// state vs the *original* server state at first click — never a burst of
// racing PUT/DELETE pairs. Mirrors the old context at
// contexts/community/context.tsx:1061-1130.
const REACTION_DEBOUNCE_MS = 300

/** Testing hook — clears any pending reaction timers without firing. */
export function _resetReactionTimers_forTesting() {
  const timers = useCommunityStore.getState().reactionTimers
  for (const { timer } of timers.values()) clearTimeout(timer)
  timers.clear()
}

/**
 * Practical toggle-reaction callback. Because the fetch verb (`PUT`/`DELETE`)
 * depends on the pre-toggle `me` state, we express the pattern here as a
 * stable closure that (a) writes the optimistic toggle synchronously, (b)
 * schedules the fetch behind a 300ms debounce keyed by `${messageId}:${emoji}`
 * so rapid re-clicks collapse to one request measured against the *original*
 * server state at first click, and (c) rolls back on failure.
 *
 * The pending-timer map lives on `useCommunityStore.reactionTimers` — its
 * `reset()` (fired on sign-out) clears any outstanding timers before they can
 * hit an already-torn-down cache.
 */
export function useToggleReactionApi(): (args: ToggleReactionArgs) => void {
  const queryClient = useQueryClient()
  return useCallback((args: ToggleReactionArgs) => {
    const key = args.channelId
      ? communityKeys.channelMessages(args.channelId)
      : args.dmId
        ? communityKeys.dmMessages(args.dmId)
        : communityKeys.channelMessages("__none__")
    const cache = queryClient.getQueryData<PageCache>(key)
    const messageKey = communityKeys.message(args.messageId)
    const singleMessage = queryClient.getQueryData<{ reactions?: Msg["reactions"] }>(messageKey)
    const scope = messageScope(args)
    const source = scope
      ? currentMaterializedMessage(cache, scope, args.messageId)
      : undefined
    const wasMe = source
      ? source.reactions?.find((reaction) => reaction.emoji === args.emoji)?.me ?? false
      : singleMessage
        ? singleMessage.reactions?.find((reaction) => reaction.emoji === args.emoji)?.me ?? false
        : currentMeStatus(cache, args.messageId, args.emoji)
    const nextMe = !wasMe
    // Optimistic write is always synchronous — the debounce only defers the
    // API call, not the visible UI.
    queryClient.setQueryData<PageCache>(key, (c) =>
      togglePageCacheReaction(c, args.messageId, args.emoji, args.userId, nextMe),
    )
    queryClient.setQueryData(messageKey, (message: typeof singleMessage) =>
      toggleSingleMessageReaction(message, args.emoji, args.userId, nextMe),
    )
    refreshExistingReactionFallback(queryClient.getQueryData<PageCache>(key), args, nextMe)

    const timerKey = `${args.messageId}:${args.emoji}`
    const reactionTimers = useCommunityStore.getState().reactionTimers
    const pending = reactionTimers.get(timerKey)
    if (pending) {
      clearTimeout(pending.timer)
      // If this click reverts to the ORIGINAL server state (net-zero over the
      // debounce window), cancel outright — no API call ever fires.
      if (pending.originalMe === nextMe) {
        reactionTimers.delete(timerKey)
        return
      }
    }
    // `originalMe` is the server state at the very first click in this window
    // — subsequent clicks within 300ms retain that capture so the final API
    // verb reflects the true diff, not the intermediate optimistic flip-flops.
    const originalMe = pending?.originalMe ?? wasMe

    const timer = setTimeout(() => {
      reactionTimers.delete(timerKey)
      const method = originalMe ? "DELETE" : "PUT"
      const url = `/api/community/messages/${args.messageId}/reactions/${encodeURIComponent(args.emoji)}`
      apiFetch(url, { method }).catch(() => {
        // Roll back to the original server state on failure.
        queryClient.setQueryData<PageCache>(key, (c) =>
          togglePageCacheReaction(c, args.messageId, args.emoji, args.userId, originalMe),
        )
        queryClient.setQueryData(messageKey, (message: typeof singleMessage) =>
          toggleSingleMessageReaction(message, args.emoji, args.userId, originalMe),
        )
        refreshExistingReactionFallback(queryClient.getQueryData<PageCache>(key), args, originalMe)
      })
    }, REACTION_DEBOUNCE_MS)
    reactionTimers.set(timerKey, { timer, originalMe })
  }, [queryClient])
}

// ── Pin / unpin ────────────────────────────────────────────────────────────

export type PinMessageArgs = { channelId: string; messageId: string }

/**
 * Pin a message. The pins list (`communityKeys.pins(channelId)`) is small; we
 * refetch on success rather than reconstructing the enriched Msg locally.
 */
export function usePinMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, PinMessageArgs, { key: readonly unknown[] } | undefined>({
    mutationFn: async ({ channelId, messageId }) => {
      await apiFetch(`/api/community/channels/${channelId}/pins`, {
        method: "POST",
        body: JSON.stringify({ messageId }),
      })
    },
    onSuccess: (_data, args) => {
      // Server broadcasts pin.add which triggers cache invalidation via WS.
      // Still poke pins() here so a same-tab pinner sees it before the WS
      // arrives (avoids "wait, did I click that?" flicker).
      void queryClient.invalidateQueries({ queryKey: communityKeys.pins(args.channelId) })
    },
  })
}

export type UnpinMessageArgs = { channelId: string; messageId: string }

export function useUnpinMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, UnpinMessageArgs, { snapshot: PinsResponse | undefined; key: readonly unknown[] }>({
    mutationFn: async ({ channelId, messageId }) => {
      await apiFetch(`/api/community/channels/${channelId}/pins/${messageId}`, {
        method: "DELETE",
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.pins(args.channelId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<PinsResponse>(key)
      queryClient.setQueryData<PinsResponse | undefined>(key, (prev) =>
        prev ? { ...prev, pins: prev.pins.filter((p) => p.id !== args.messageId) } : prev,
      )
      return { snapshot, key }
    },
    onError: (_err, _args, ctx) => {
      if (!ctx) return
      if (ctx.snapshot) queryClient.setQueryData(ctx.key, ctx.snapshot)
    },
  })
}

// ── Mark / unmark (per-user saved messages) ──────────────────────────────────
//
// mark ≠ pin: a pin is channel-scoped and shared; a mark is the viewer's own
// private saved-messages set. So these hit a distinct per-user route
// (`/api/community/messages/{id}/marks`, self-scoped by ctx.userId server-side), never the
// pins route. The ⋯ menu's Mark/Unmark label is driven by `useMessageMarked`
// (a lazy single-row read on menu-open); these mutations flip that per-message
// cache optimistically so the label updates instantly, and prune the Marked
// list on unmark. POST is idempotent server-side (UNIQUE(userId,messageId)).

export type MarkMessageArgs = { channelId: string; messageId: string }

export function useMarkMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, MarkMessageArgs, { prev: MessageMarkedResponse | undefined }>({
    mutationFn: async ({ channelId, messageId }) => {
      // Message-keyed mark door (route/disc marks relocation): messageId in path,
      // channelId in body (the membership + belongs-to-channel gate). PUT = mark.
      await apiFetch(`/api/community/messages/${messageId}/marks`, {
        method: "PUT",
        body: JSON.stringify({ channelId }),
      })
    },
    onMutate: async ({ messageId }) => {
      const key = communityKeys.messageMarked(messageId)
      await queryClient.cancelQueries({ queryKey: key })
      const prev = queryClient.getQueryData<MessageMarkedResponse>(key)
      queryClient.setQueryData<MessageMarkedResponse>(key, { marked: true })
      return { prev }
    },
    onSuccess: () => {
      // The Marked list gains a row — refetch it so the tab reflects the new
      // save next time it's opened (list carries the enriched snapshot + seq
      // we don't reconstruct locally).
      void queryClient.invalidateQueries({ queryKey: communityKeys.inboxMarked() })
    },
    onError: (err, args, ctx) => {
      queryClient.setQueryData(communityKeys.messageMarked(args.messageId), ctx?.prev)
      toastApiError(err, "Failed to mark message")
    },
  })
}

export type UnmarkMessageArgs = { messageId: string }

export function useUnmarkMessage() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, UnmarkMessageArgs, {
    prevMarked: MessageMarkedResponse | undefined
    prevList: MarkedResponse | undefined
  }>({
    mutationFn: async ({ messageId }) => {
      await apiFetch(`/api/community/messages/${messageId}/marks`, { method: "DELETE" })
    },
    onMutate: async ({ messageId }) => {
      const markedKey = communityKeys.messageMarked(messageId)
      const listKey = communityKeys.inboxMarked()
      await queryClient.cancelQueries({ queryKey: markedKey })
      const prevMarked = queryClient.getQueryData<MessageMarkedResponse>(markedKey)
      const prevList = queryClient.getQueryData<MarkedResponse>(listKey)
      queryClient.setQueryData<MessageMarkedResponse>(markedKey, { marked: false })
      // Drop the row from the Marked list immediately (list rows are keyed by
      // the message id via `m.id`, mirroring useDeleteMention's optimistic prune).
      queryClient.setQueryData<MarkedResponse | undefined>(listKey, (prev) =>
        prev ? { ...prev, marked: prev.marked.filter((mk) => mk.m.id !== messageId) } : prev,
      )
      return { prevMarked, prevList }
    },
    onError: (err, args, ctx) => {
      queryClient.setQueryData(communityKeys.messageMarked(args.messageId), ctx?.prevMarked)
      if (ctx?.prevList) queryClient.setQueryData(communityKeys.inboxMarked(), ctx.prevList)
      toastApiError(err, "Failed to unmark message")
    },
  })
}

/**
 * Toggle a message's marked state with one call. Reads the per-message
 * `messageMarked` cache — populated by `useMessageMarked` when the menu that
 * fired this action opened — to decide POST (mark) vs DELETE (unmark). If the
 * read hasn't landed yet (cache miss), defaults to marking, which is safe:
 * POST is idempotent server-side, so a double-mark is a no-op rather than an
 * error. Returns a stable callback for the message-actions bundle.
 */
export function useToggleMark() {
  const queryClient = useQueryClient()
  const { mutate: markMutate } = useMarkMessage()
  const { mutate: unmarkMutate } = useUnmarkMessage()
  return useCallback(
    (channelId: string, messageId: string) => {
      const cached = queryClient.getQueryData<MessageMarkedResponse>(
        communityKeys.messageMarked(messageId),
      )
      if (cached?.marked) {
        unmarkMutate({ messageId }, { onSuccess: () => toast("Removed from marked") })
      } else {
        markMutate({ channelId, messageId }, { onSuccess: () => toast("Message marked") })
      }
    },
    [queryClient, markMutate, unmarkMutate],
  )
}

// ── Create thread ──────────────────────────────────────────────────────────

export type CreateThreadArgs = {
  serverId: string
  channelId: string // parent channel — used to invalidate the threads list
  messageId: string
  name: string
}

export type CreateThreadResult = { id: string }

export function useCreateThread() {
  const queryClient = useQueryClient()
  return useMutation<CreateThreadResult, Error, CreateThreadArgs>({
    mutationFn: async ({ messageId, name }) => {
      // Unified create door (route/disc create-door step): POST /channels with
      // {type:"thread", messageId, name} → get-or-create thread by root message.
      return apiFetch<CreateThreadResult>(
        `/api/community/channels`,
        { method: "POST", body: JSON.stringify({ type: "thread", messageId, name }) },
      )
    },
    onSuccess: (data, args) => {
      // Live-patch the message row so the "Open thread" affordance appears
      // immediately, then invalidate the thread list.
      queryClient.setQueryData<PageCache>(
        communityKeys.channelMessages(args.channelId),
        (cache) => {
          if (!cache) return cache
          let touched = false
          const pages = cache.pages.map((p) => {
            if (!p.messages.some((m) => m.id === args.messageId)) return p
            touched = true
            return {
              ...p,
              messages: p.messages.map((m) =>
                m.id === args.messageId
                  ? { ...m, thread: { id: data.id, name: args.name, messageCount: 0 } }
                  : m,
              ),
            }
          })
          if (!touched) return cache
          return { ...cache, pages }
        },
      )
      const scope: MessageScope = { kind: "channel", id: args.channelId, serverId: args.serverId }
      const fallback = [...getMessageOverlay(scope).liveById.values()]
        .find((message) => message.id === args.messageId)
      if (fallback) {
        const cached = queryClient.getQueryData<PageCache>(communityKeys.channelMessages(args.channelId))
        const source = currentMaterializedMessage(cached, scope, args.messageId) ?? fallback
        if (source.seq !== undefined) {
          useMessageStreamStore.getState().dispatch(scope, {
            type: "liveRefreshed",
            message: {
              ...source,
              seq: source.seq,
              thread: { id: data.id, name: args.name, messageCount: 0 },
            },
          })
        }
      }
      void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.channelId) })
    },
  })
}

// ── Inbox mutations ────────────────────────────────────────────────────────

export function useMarkAllInboxRead() {
  const queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  type ReadAllResponse = { revision: number }
  type DomainResult = {
    domain: AccountUnreadDomain
    result: PromiseSettledResult<ReadAllResponse>
  }
  type MarkAllContext = { tokens: Map<AccountUnreadDomain, MarkAllToken> }
  return useMutation<DomainResult[], Error, void, MarkAllContext>({
    mutationFn: async () => {
      const requests = [
        ["mentions", "/api/community/users/me/inbox/mentions/read-all"],
        ["channels", "/api/community/users/me/inbox/unreads/read-all"],
        ["dms", "/api/community/users/me/inbox/dms/read-all"],
      ] as const
      const settled = await Promise.allSettled(requests.map(([, path]) => (
        apiFetch<ReadAllResponse>(path, { method: "POST" })
      )))
      const results = requests.map(([domain], index) => ({
        domain,
        result: settled[index]!,
      }))
      const failures = results.filter(
        (entry): entry is DomainResult & { result: PromiseRejectedResult } => (
          entry.result.status === "rejected"
        ),
      )
      if (failures.length === results.length) {
        throw failures[0]!.result.reason
      }
      return results
    },
    onMutate: async () => {
      return {
        tokens: new Map<AccountUnreadDomain, MarkAllToken>([
          ["channels", unreadProjection.beginMarkAll("channels")],
          ["dms", unreadProjection.beginMarkAll("dms")],
          ["mentions", unreadProjection.beginMarkAll("mentions")],
        ]),
      }
    },
    onSuccess: (results, _variables, context) => {
      let targetRevision = 0
      let firstFailure: unknown
      for (const { domain, result } of results) {
        const token = context.tokens.get(domain)
        if (!token) continue
        if (result.status === "fulfilled") {
          targetRevision = Math.max(targetRevision, result.value?.revision ?? 0)
          unreadProjection.commitMarkAll(token, result.value?.revision ?? 0)
        } else {
          unreadProjection.rollbackMarkAll(token)
          firstFailure ??= result.reason
        }
      }
      if (firstFailure) toastApiError(firstFailure, "Some inbox items could not be marked read")
      void reconcileAccountReadState(queryClient, {
        surfaceMode: "all",
        targetRevision,
      }).catch(() => undefined)
    },
    onError: (e, _variables, context) => {
      for (const token of context?.tokens.values() ?? []) {
        unreadProjection.rollbackMarkAll(token)
      }
      toastApiError(e, "Failed to mark inbox read")
      void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
  })
}

export type DeleteMentionArgs = { mentionId: string }

export function useDeleteMention() {
  const queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  return useMutation<
    { revision: number },
    Error,
    DeleteMentionArgs,
    { snapshot: MentionsResponse | undefined; token?: AccountUnreadDismissToken }
  >({
    mutationFn: async ({ mentionId }) => {
      return apiFetch<{ revision: number }>(
        `/api/community/users/me/inbox/mentions/${mentionId}`,
        { method: "DELETE" },
      )
    },
    onMutate: async (args) => {
      const key = communityKeys.inboxMentions()
      const snapshot = queryClient.getQueryData<MentionsResponse>(key)
      const row = snapshot?.mentions.find((mention) => mention.id === args.mentionId)
      const token = row?.channelId
        ? unreadProjection.beginDismissMention({
            mentionId: args.mentionId,
            channelId: row.channelId,
            seq: row.m.seq,
            countsServerMention: row.kind !== "reply",
          })
        : undefined
      queryClient.setQueryData(key, (prev: { mentions: { id: string }[] } | undefined) =>
        prev ? { ...prev, mentions: prev.mentions.filter((m) => m.id !== args.mentionId) } : prev,
      )
      return { snapshot, token }
    },
    onSuccess: (result, _args, context) => {
      if (context.token) unreadProjection.commitDismissMention(context.token, result?.revision)
      // Deleting a mention row removes it from the unread-mention aggregate
      // that feeds the server rail badge — refresh so the count drops.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
    onError: (err, _args, ctx) => {
      if (ctx?.token) unreadProjection.rollbackDismissMention(ctx.token)
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.inboxMentions(), ctx.snapshot)
      toastApiError(err, "Failed to remove mention")
    },
  })
}

// ── Load more messages ─────────────────────────────────────────────────────
// `fetchOlder` is exposed by `useMessages` / `useDmMessages` directly; there
// is no need for a dedicated mutation hook. Kept as a note here for clarity.
