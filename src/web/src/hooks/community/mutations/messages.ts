"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useCommunityMutationOrigin } from "../community-origin"
import { getCommunityRuntime, useCommunityRuntime } from "@/stores/community/runtime"



import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { ApiError, isAbortError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { publishCommunityMessageFields, publishCommunityMessages, publishCommunityCreatedChannel } from "@/lib/community-db/sync"
import { isInlineAttachmentContentType } from "@/lib/community/attachment-content-type"
import { formatAttachmentSize } from "@/lib/community/attachment-presentation"
import { attachmentThumbnailUrl, attachmentUrl } from "@/lib/community/storage"
import {
  projectPostedMessage,
  type PostedMessage,
} from "@/lib/community/message-wire"



import type { Attachment, Msg } from "@/lib/community/models/message"


import {
  getForumSidebarBase,
  hasForumSidebarThread,
  invalidateForumSidebarBaseExact,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
} from "@/hooks/community/use-forum-sidebar-threads"
import { isBlocked, type MentionType } from "@alook/shared"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadDomain,
  type AccountUnreadDismissToken,
  type MarkAllToken,
} from "@/hooks/community/account-unread-projection"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import { reconcileAccountAttention } from "@/hooks/community/use-account-attention"

import {
  clearAttentionOptimistically,
  commitAttentionOptimisticSnapshot,
  commitAttentionItemsOptimisticSnapshot,
  getCanonicalCommunityMessages,
  removeAttentionItemsOptimistically,
  restoreAttentionOptimisticDomains,
  restoreAttentionOptimisticSnapshot,
  restoreAttentionItemsOptimisticSnapshot,
  type AttentionOptimisticSnapshot,
  type AttentionItemsOptimisticSnapshot,
} from "@/lib/community-db/sync"


type OriginalView = (() => void) & { signal: AbortSignal }

type EditMessageArgs = {
  assertActive?: OriginalView
  serverId: string
  channelId: string
  messageId: string
  content: string
  forumChannelId?: string
  forumThreadId?: string
}

export function useEditMessage() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type Intent = EditMessageArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<void, Error, Intent>({
    scope: { id: "community-message-field-commands" },
    mutationFn: async ({ channelId, messageId, content, original: token, assertActive }) => {
      origin.assert(token); assertActive?.()
      const registry = origin.registry
      await registry?.ready
      origin.assert(token); assertActive?.()
      await registry!.collections.messages.preload()
      origin.assert(token); assertActive?.()
      await Promise.all([
        queryClient.cancelQueries({ queryKey: communityKeys.channelMessages(channelId) }),
        queryClient.cancelQueries({ queryKey: communityKeys.message(messageId), exact: true }),
      ])
      origin.assert(token); assertActive?.()
      const persist = async () => {
        try {
          await apiFetch(`/api/community/messages/${messageId}`, {
            method: "PATCH",
            body: JSON.stringify({ content }),
            ...communityRequestOptions(queryClient, token, assertActive?.signal, () => { origin.assert(token); assertActive?.() }),
          })
          origin.assert(token); assertActive?.()
          publishCommunityMessageFields(queryClient, messageId, { content }, { token, signal: assertActive?.signal })
        } catch (error) { origin.assert(token); throw error }
      }
      const transaction = registry!.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      transaction.mutate(() => {
        if (registry!.collections.messages.has(messageId)) {
          registry!.collections.messages.update(messageId, (row) => { row.content = content })
        }
      })
      try { if (transaction.mutations.length) await transaction.commit(); else await persist() } catch (error) { origin.assert(token); throw error }
    },
  })
  const capture = useCallback((input: EditMessageArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
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
  assertActive?: OriginalView
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
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type Intent = SendMessageArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<
    SendMessageResult,
    Error,
    Intent
  >({
    mutationFn: async ({ channelId, content, replyToId, replyTo, mentionType, attachments, nonce, original: token, assertActive }) => {
      origin.assert(token); assertActive?.()
      // Server receives only the attachment IDS (reserve-by-id); the rest of the
      // descriptor is client-only (optimistic VM). Dimensions already rode the
      // upload, so they are NOT re-sent here (single-source guard).
      const attachmentIds = attachments?.map((a) => a.id)
      const result = await origin.request<SendMessageResult>(token,
        `/api/community/channels/${channelId}/messages`,
        {
          method: "POST",
          signal: assertActive?.signal,
          assertActive,
          body: JSON.stringify({
            content,
            replyToId: replyTo?.id ?? replyToId,
            mentionType,
            attachments: attachmentIds,
            nonce,
          }),
        },
      )
      await origin.registry!.collections.messages.preload()
      origin.assert(token); assertActive?.()
      const message = projectPostedMessage(result.message, nonce ?? "")
      publishCommunityMessages(queryClient, { channelId, messages: [{ ...message, ...(attachments?.length ? { attachments: attachments.map((attachment) => toAttachmentVm(channelId, attachment)) } : {}), ...(replyTo ? { replyTo } : {}) }], proof: { token, signal: assertActive?.signal } })
      return result
    },
    onError: (err, args) => {
      try { origin.assert(args.original) } catch { return }
      if (args.nonce) {
        getCommunityRuntime(queryClient).messageStream.actions.dispatch(
          { kind: "channel", id: args.channelId, serverId: args.serverId },
          { type: "postFail", nonce: args.nonce },
        )
      }
      try { args.assertActive?.() } catch { return }
      if (isAbortError(err)) return
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
      try { origin.assert(args.original) } catch { return }
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
      getCommunityRuntime(queryClient).messageStream.actions.dispatch(
        { kind: "channel", id: args.channelId, serverId: args.serverId },
        {
          type: "postAck",
          nonce: args.nonce,
          message: projectPostedMessage(data.message, args.nonce),
        },
      )
    },
  })
  const capture = useCallback((input: SendMessageArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

// ── Send DM message ────────────────────────────────────────────────────────

export type SendDmMessageArgs = {
  assertActive?: (() => void) & { signal: AbortSignal }
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
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  const communityRuntime = useCommunityRuntime()
  type Intent = SendDmMessageArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<
    SendMessageResult,
    Error,
    Intent
  >({
    mutationFn: async ({ dmId, content, replyToId, replyTo, attachments, nonce, original: token, assertActive }) => {
      origin.assert(token); assertActive?.()
      const attachmentIds = attachments?.map((a) => a.id)
      const result = await origin.request<SendMessageResult>(token,
        `/api/community/channels/${dmId}/messages`,
        {
          method: "POST",
          signal: assertActive?.signal,
          assertActive,
          body: JSON.stringify({
            content,
            replyToId: replyTo?.id ?? replyToId,
            attachments: attachmentIds,
            nonce,
          }),
        },
      )
      await origin.registry!.collections.messages.preload()
      origin.assert(token)
      assertActive?.()
      publishCommunityMessages(queryClient, { channelId: dmId, messages: [{ ...projectPostedMessage(result.message, nonce), ...(attachments?.length ? { attachments: attachments.map((attachment) => toAttachmentVm(dmId, attachment)) } : {}), ...(replyTo ? { replyTo } : {}) }], proof: { token } })
      return result
    },
    onError: (err, args) => {
      try { origin.assert(args.original) } catch { return }
      const scope = { kind: "dm" as const, id: args.dmId }
      if (err instanceof ApiError && err.status === 403 && isBlocked(err.message)) {
        communityRuntime.messageStream.actions.dispatch(scope, {
          type: "terminalReject",
          nonce: args.nonce,
        })
        try { args.assertActive?.() } catch { return }
        toast("You cannot send messages to this user")
        return
      }
      communityRuntime.messageStream.actions.dispatch(scope, {
        type: "postFail",
        nonce: args.nonce,
      })
      try { args.assertActive?.() } catch { return }
      if (isAbortError(err)) return
      if (err instanceof ApiError && err.status === 429) {
        toast.error("Rate limited — please wait a moment before trying again")
      } else {
        toastApiError(err, "Failed to send message")
      }
    },
    onSuccess: (data, args) => {
      try { origin.assert(args.original) } catch { return }
      communityRuntime.messageStream.actions.dispatch(
        { kind: "dm", id: args.dmId },
        {
          type: "postAck",
          nonce: args.nonce,
          message: projectPostedMessage(data.message, args.nonce),
        },
      )
    },
  })
  const capture = useCallback((input: SendDmMessageArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

// ── Reaction intents ──────────────────────────────────────────────────────

export type { ReactionArgs } from "./message-command-inputs"

export { useToggleReactionApi, useAddReactionApi } from "./message-reactions"

// ── Pin / unpin ────────────────────────────────────────────────────────────

export { usePinMessage, useUnpinMessage, useMarkMessage, useUnmarkMessage, useToggleMark } from "./message-memberships"

// ── Create thread ──────────────────────────────────────────────────────────

export type CreateThreadArgs = {
  assertActive?: OriginalView
  serverId: string
  channelId: string // parent channel — used to invalidate the threads list
  messageId: string
  name: string
}

export type CreateThreadResult = { id: string }

export function useCreateThread() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  type Intent = CreateThreadArgs & { original: ReturnType<typeof origin.begin>["token"]; resource: ReturnType<ReturnType<typeof queryClient.getQueryCache>["find"]> }
  const native = useMutation<CreateThreadResult, Error, Intent>({
    mutationFn: async (args) => {
      const token = args.original
      origin.assert(token); args.assertActive?.()
      await origin.registry?.ready
      origin.assert(token); args.assertActive?.()
      await Promise.all([origin.registry!.collections.channels.preload(), origin.registry!.collections.messages.preload()])
      origin.assert(token); args.assertActive?.()
      const data = await origin.request<CreateThreadResult>(token, "/api/community/channels", { method: "POST", signal: args.assertActive?.signal, assertActive: args.assertActive, body: JSON.stringify({ type: "thread", messageId: args.messageId, name: args.name }) })
      publishCommunityCreatedChannel(queryClient, { id: data.id, serverId: args.serverId, categoryId: null, name: args.name, type: "thread", parentChannelId: args.channelId, parentMessageId: args.messageId, creatorId: origin.registry!.accountId, position: 0, archived: false, muted: false, unread: false, tags: [], pending: false, messageCount: 0 }, { token, signal: args.assertActive?.signal })
      if (args.resource && queryClient.getQueryCache().find({ queryKey: communityKeys.threads(args.channelId), exact: true }) === args.resource) void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.channelId), exact: true }, { cancelRefetch: false }).catch(() => undefined)
      return data
    },
  })
  const capture = useCallback((input: CreateThreadArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token, resource: queryClient.getQueryCache().find({ queryKey: communityKeys.threads(input.channelId), exact: true }) } }, [origin, queryClient])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

// ── Inbox mutations ────────────────────────────────────────────────────────

export function useMarkAllInboxRead() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  type ReadAllResponse = { revision: number }
  type DomainResult = {
    domain: AccountUnreadDomain
    result: PromiseSettledResult<ReadAllResponse>
  }
  type MarkAllContext = {
    tokens: Map<AccountUnreadDomain, MarkAllToken>
    snapshot?: AttentionOptimisticSnapshot
  }
  type Original = ReturnType<typeof origin.begin>["token"]
  const mutation = useMutation<DomainResult[], Error, Original, MarkAllContext>({
    scope: { id: "community-inbox-read-all" },
    mutationFn: async (original) => {
      const requests = [
        ["mentions", "/api/community/users/me/inbox/mentions/read-all"],
        ["channels", "/api/community/users/me/inbox/unreads/read-all"],
        ["dms", "/api/community/users/me/inbox/dms/read-all"],
      ] as const
      const settled = await Promise.allSettled(requests.map(([, path]) => (
        origin.request<ReadAllResponse>(original, path, { method: "POST" })
      )))
      const results = requests.map(([domain], index) => ({
        domain,
        result: settled[index]!,
      }))
      origin.assert(original)
      const failures = results.filter(
        (entry): entry is DomainResult & { result: PromiseRejectedResult } => (
          entry.result.status === "rejected"
        ),
      )
      if (failures.length === results.length) throw failures[0]!.result.reason
      return results
    },
    onMutate: async (token) => {
      const registry = origin.registry
      await registry?.ready
      origin.assert(token)
      await Promise.all([registry!.collections.attentionScopes.preload(), registry!.collections.attentionItems.preload()])
      origin.assert(token)
      return {
        tokens: new Map<AccountUnreadDomain, MarkAllToken>([
          ["channels", unreadProjection.beginMarkAll("channels")],
          ["dms", unreadProjection.beginMarkAll("dms")],
          ["mentions", unreadProjection.beginMarkAll("mentions")],
        ]),
        snapshot: registry ? clearAttentionOptimistically(registry) : undefined,
      }
    },
    onSuccess: async (results, original, context) => {
      origin.assert(original)
      let targetRevision = 0
      let firstFailure: unknown
      const failedDomains = new Set<AccountUnreadDomain>()
      for (const { domain, result } of results) {
        const token = context.tokens.get(domain)
        if (!token) continue
        if (result.status === "fulfilled") {
          targetRevision = Math.max(targetRevision, result.value?.revision ?? 0)
          unreadProjection.commitMarkAll(token, result.value?.revision ?? 0)
        } else {
          unreadProjection.rollbackMarkAll(token)
          failedDomains.add(domain)
          firstFailure ??= result.reason
        }
      }
      const registry = origin.registry
      if (registry && context.snapshot) {
        if (failedDomains.size === 0) {
          await commitAttentionOptimisticSnapshot(registry, context.snapshot)
        } else {
          await restoreAttentionOptimisticDomains(registry, context.snapshot, failedDomains)
        }
      }
      origin.assert(original)
      if (registry) void reconcileAccountAttention(registry).catch(() => undefined)
      if (firstFailure) toastApiError(firstFailure, "Some inbox items could not be marked read")
      void reconcileAccountReadState(queryClient, {
        surfaceMode: "all",
        targetRevision,
      }).catch(() => undefined)
    },
    onError: (e, original, context) => {
      for (const token of context?.tokens.values() ?? []) {
        unreadProjection.rollbackMarkAll(token)
      }
      const registry = origin.registry
      if (registry && context?.snapshot) {
        restoreAttentionOptimisticSnapshot(registry, context.snapshot)
      }
      try { origin.assert(original) } catch { return }
      if (isAbortError(e)) return
      if (registry) void reconcileAccountAttention(registry).catch(() => undefined)
      toastApiError(e, "Failed to mark inbox read")
      void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
  })
  return {
    ...mutation,
    mutate: (_variables?: void, options?: Parameters<typeof mutation.mutate>[1]) => mutation.mutate(origin.begin().token, options),
    mutateAsync: (_variables?: void, options?: Parameters<typeof mutation.mutateAsync>[1]) => mutation.mutateAsync(origin.begin().token, options),
  }
}

export type DeleteMentionArgs = { mentionId: string }

export function useDeleteMention() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  type Original = ReturnType<typeof origin.begin>["token"]
  const mutation = useMutation<
    { revision: number },
    Error,
    { input: DeleteMentionArgs; original: Original },
    {
      token?: AccountUnreadDismissToken
      attentionSnapshot?: AttentionItemsOptimisticSnapshot
    }
  >({
    scope: { id: "community-mention-delete" },
    mutationFn: async ({ input: { mentionId }, original }) => {
      return origin.request<{ revision: number }>(original,
        `/api/community/users/me/inbox/mentions/${mentionId}`,
        { method: "DELETE" },
      )
    },
    onMutate: async ({ input: args, original }) => {
      const registry = origin.registry
      await registry?.ready
      origin.assert(original)
      await Promise.all([registry!.collections.attentionScopes.preload(), registry!.collections.attentionItems.preload()])
      origin.assert(original)
      const removed = Array.from(registry!.collections.attentionItems.values()).find((item) => item.sourceId === args.mentionId && (item.kind === "mention" || item.kind === "reply"))
      const attentionSnapshot = registry
        ? removeAttentionItemsOptimistically(
            registry,
            (item) => (
              item.sourceId === args.mentionId
              && (item.kind === "mention" || item.kind === "reply")
            ),
          )
        : undefined
      const message = removed?.messageId
        ? getCanonicalCommunityMessages(queryClient)
          .find((candidate) => candidate.id === removed.messageId)
        : undefined
      const token = removed?.scopeId && message?.seq !== undefined
        ? unreadProjection.beginDismissMention({
            mentionId: args.mentionId,
            channelId: removed.scopeId,
            seq: message.seq,
            countsServerMention: removed.kind === "mention",
          })
        : undefined
      return { token, attentionSnapshot }
    },
    onSuccess: async (result, { original }, context) => {
      origin.assert(original)
      if (context.token) unreadProjection.commitDismissMention(context.token, result?.revision)
      const registry = origin.registry
      if (registry && context.attentionSnapshot) {
        await commitAttentionItemsOptimisticSnapshot(registry, context.attentionSnapshot)
        origin.assert(original)
        void reconcileAccountAttention(registry).catch(() => undefined)
      }
      // Deleting a mention row removes it from the unread-mention aggregate
      // that feeds the server rail badge — refresh so the count drops.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers() })
    },
    onError: (err, { original }, ctx) => {
      if (ctx?.token) unreadProjection.rollbackDismissMention(ctx.token)
      const registry = origin.registry
      if (registry && ctx?.attentionSnapshot) {
        restoreAttentionItemsOptimisticSnapshot(registry, ctx.attentionSnapshot)
      }
      try { origin.assert(original) } catch { return }
      if (isAbortError(err)) return
      if (registry) void reconcileAccountAttention(registry).catch(() => undefined)
      toastApiError(err, "Failed to remove mention")
    },
  })
  return {
    ...mutation,
    mutate: (input: DeleteMentionArgs, options?: Parameters<typeof mutation.mutate>[1]) => mutation.mutate({ input, original: origin.begin().token }, options),
    mutateAsync: (input: DeleteMentionArgs, options?: Parameters<typeof mutation.mutateAsync>[1]) => mutation.mutateAsync({ input, original: origin.begin().token }, options),
  }
}

// ── Load more messages ─────────────────────────────────────────────────────
// `fetchOlder` is exposed by `useMessages` / `useDmMessages` directly; there
// is no need for a dedicated mutation hook. Kept as a note here for clarity.
