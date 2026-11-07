"use client"
import { sendNonce, tempMessageId, toAttachmentVm, type OriginalView, type SendMessageArgs, type SendMessageResult, type SendDmMessageArgs } from "@/lib/community/message-send-input"
import { completeCommunityPublication } from "@/lib/community-db/sync"

import { CommunityChannelResourceSchema, type CommunityChannelResource } from "@alook/shared"

import { captureOnboardingFirstMessage } from "@/lib/product-analytics"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useCommunityMutationOrigin } from "../community-origin"
import { getCommunityRuntime } from "@/stores/community/runtime"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { ApiError, isAbortError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages, publishCommunityCreatedChannel } from "@/lib/community-db/sync"
import {
  projectPostedMessage,
  type PostedMessage,
} from "@/lib/community/message-wire"

import type { CanonicalMessage, MessageScope } from "@/lib/community/message-stream"

import {
  getForumSidebarBase,
  hasForumSidebarThread,
  invalidateForumSidebarBaseExact,
  isForumSidebarParent,
  patchForumSidebarActivityExact,
} from "@/hooks/community/use-forum-sidebar-threads"
import { isBlocked } from "@alook/shared"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import { reconcileAccountAttention } from "@/hooks/community/use-account-attention"

import {
  clearAttentionOptimistically,
  commitAttentionOptimisticSnapshot,
  commitAttentionItemsOptimisticSnapshot,
  removeAttentionItemsOptimistically,
  restoreAttentionOptimisticDomains,
  restoreAttentionOptimisticSnapshot,
  restoreAttentionItemsOptimisticSnapshot,
  type AttentionDomain,
  type AttentionIntent,
} from "@/lib/community-db/sync"

function sendMessageScope(input: SendMessageArgs | SendDmMessageArgs): MessageScope {
  return "dmId" in input ? { kind: "dm", id: input.dmId } : { kind: "channel", id: input.channelId, serverId: input.serverId }
}

export function getConfirmedSentMessage(
  error: unknown,
  origin: ReturnType<typeof useCommunityMutationOrigin>,
  original: ReturnType<ReturnType<typeof useCommunityMutationOrigin>["begin"]>["token"],
  channelId: string,
  nonce: string,
  assertActive?: OriginalView,
  assertCommand?: () => void,
): CanonicalMessage | undefined {
  if (isAbortError(error) || (error instanceof ApiError && error.status !== 0 && (error.status < 500 || error.status >= 600))) return
  try { origin.assert(original); (assertCommand ?? assertActive)?.() } catch { return }
  if (!original.viewerId || !nonce || nonce.startsWith("srv:")) return
  for (const message of origin.registry!.collections.messages.values()) {
    if (message.channelId === channelId && message.authorId === original.viewerId && message.clientNonce === nonce
      && typeof message.id === "string" && message.id.length > 0
      && typeof message.seq === "number" && Number.isSafeInteger(message.seq) && message.seq > 0) return message as CanonicalMessage
  }
}

function postedMessageForIntent(message: PostedMessage, nonce: string, channelId: string) {
  return projectPostedMessage(message, nonce, channelId)
}

function useSendScopedMessage<Args extends SendMessageArgs | SendDmMessageArgs>(kind: MessageScope["kind"]) {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type Intent = Args & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation<SendMessageResult, Error, Intent>({
    meta: { observabilityAction: `${kind}.message.send` },
    mutationFn: async (args) => {
      const { content, replyToId, replyTo, attachments, nonce, original: token, assertActive, assertCommand } = args
      origin.assert(token); (assertCommand ?? assertActive)?.()
      const scope = sendMessageScope(args)
      const result = await origin.request<SendMessageResult>(token, `/api/community/channels/${scope.id}/messages`, {
        method: "POST", signal: assertCommand ? undefined : assertActive?.signal, assertActive: assertCommand ?? assertActive,
        body: JSON.stringify({ content, replyToId: replyTo?.id ?? replyToId,
          mentionType: "serverId" in args ? args.mentionType : undefined,
          attachments: attachments?.map((attachment) => attachment.id), nonce }),
      })
      await origin.registry!.collections.messages.preload()
      origin.assert(token); (assertCommand ?? assertActive)?.()
      const message = postedMessageForIntent(result.message, nonce ?? "", scope.id)
      await publishCommunityMessages(queryClient, { channelId: scope.id, profiles: result.profiles,
        messages: [message], relatedMessages: result.relatedMessages,
        proof: { token, ...(scope.kind === "channel" && !assertCommand ? { signal: assertActive?.signal } : {}) } })
      return result
    },
    onError: (error, args) => {
      try { origin.assert(args.original); args.assertCommand?.() } catch { return }
      const scope = sendMessageScope(args)
      const stream = getCommunityRuntime(queryClient).messageStream.actions
      const nonce = args.nonce ?? ""
      if (scope.kind === "dm" && error instanceof ApiError && error.status === 403 && isBlocked(error.message)) {
        stream.dispatch(scope, { type: "terminalReject", nonce })
        try { args.assertActive?.() } catch { return }
        toast("You cannot send messages to this user")
        return
      }
      const confirmed = getConfirmedSentMessage(error, origin, args.original, scope.id, nonce, args.assertActive, args.assertCommand)
      if (confirmed) {
        stream.dispatch(scope, { type: "wsMessage", message: confirmed })
        return
      }
      if (scope.kind === "dm" || args.nonce) stream.dispatch(scope, { type: "postFail", nonce })
      try { args.assertActive?.() } catch { return }
      if (isAbortError(error)) return
      if (error instanceof ApiError && error.status === 429) toast.error("Rate limited — please wait a moment before trying again")
      else toastApiError(error, "Failed to send message", () => { origin.assert(args.original); args.assertActive?.() })
    },
    onSuccess: async (data, args) => {
      try { origin.assert(args.original); args.assertCommand?.() } catch { return }
      if ("serverId" in args) captureOnboardingFirstMessage(args.author.id, args.serverId)
      if (
        "serverId" in args && args.forumParentChannelId &&
        isForumSidebarParent(queryClient, args.serverId, args.forumParentChannelId)
      ) {
        const canonical = hasForumSidebarThread(
          getForumSidebarBase(queryClient, args.serverId),
          args.channelId,
        )
        await completeCommunityPublication(queryClient, () => patchForumSidebarActivityExact(
          queryClient,
          args.serverId,
          args.channelId,
          args.forumParentChannelId!,
          data.message.createdAt,
        ))
        if (!canonical) {
          void invalidateForumSidebarBaseExact(queryClient, args.serverId)
        }
      }
      const scope = sendMessageScope(args)
      const nonce = args.nonce ?? ""
      if (scope.kind === "dm" || args.nonce) getCommunityRuntime(queryClient).messageStream.actions.dispatch(scope, {
        type: "postAck", nonce, message: postedMessageForIntent(data.message, nonce, scope.id),
      })
    },
  })
  const capture = useCallback((input: Args): Intent => { (input.assertCommand ?? input.assertActive)?.(); return { ...input, original: input.assertCommand ? captureCommunityLiveSnapshotToken(queryClient, sendMessageScope(input).id) : origin.begin().token } }, [origin, queryClient])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export function useSendMessage() {
  return useSendScopedMessage<SendMessageArgs>("channel")
}

export function useSendDmMessage() {
  return useSendScopedMessage<SendDmMessageArgs>("dm")
}

export type { ReactionArgs } from "./message-command-inputs"

export { useToggleReactionApi, useAddReactionApi } from "./message-reactions"

export { usePinMessage, useUnpinMessage, useMarkMessage, useUnmarkMessage, useToggleMark } from "./message-memberships"

export type CreateThreadArgs = {
  assertActive?: OriginalView
  serverId: string
  channelId: string // parent channel — used to invalidate the threads list
  messageId: string
  name: string
}

export type CreateThreadResult = CommunityChannelResource

export function useCreateThread() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  type Intent = CreateThreadArgs & { original: ReturnType<typeof origin.begin>["token"]; resource: ReturnType<ReturnType<typeof queryClient.getQueryCache>["find"]> }
  const native = useMutation<CreateThreadResult, Error, Intent>({ meta: { observabilityAction: "message.thread.create" },
    mutationFn: async (args) => {
      const token = args.original
      origin.assert(token); args.assertActive?.()
      await origin.registry?.ready
      origin.assert(token); args.assertActive?.()
      await Promise.all([origin.registry!.collections.channels.preload(), origin.registry!.collections.messages.preload()])
      origin.assert(token); args.assertActive?.()
      const data = await origin.request<CreateThreadResult>(token, "/api/community/channels", { method: "POST", signal: args.assertActive?.signal, assertActive: args.assertActive, body: JSON.stringify({ type: "thread", messageId: args.messageId, name: args.name }) })
      origin.assert(token); args.assertActive?.()
      const channel = CommunityChannelResourceSchema.parse(data)
      if (channel.type !== "thread" || channel.serverId !== args.serverId || channel.parentChannelId !== args.channelId || channel.parentMessageId !== args.messageId) throw new Error("Created thread scope mismatch")
      await completeCommunityPublication(queryClient, () => publishCommunityCreatedChannel(queryClient, { ...channel, pending: false }, { token, signal: args.assertActive?.signal }))
      if (args.resource && queryClient.getQueryCache().find({ queryKey: communityKeys.threads(args.channelId), exact: true }) === args.resource) void queryClient.invalidateQueries({ queryKey: communityKeys.threads(args.channelId), exact: true }, { cancelRefetch: false }).catch(() => undefined)
      return data
    },
  })
  const capture = useCallback((input: CreateThreadArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token, resource: queryClient.getQueryCache().find({ queryKey: communityKeys.threads(input.channelId), exact: true }) } }, [origin, queryClient])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export function useMarkAllInboxRead() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type ReadAllResponse = { revision: number }
  type DomainResult = {
    domain: AttentionDomain
    result: PromiseSettledResult<ReadAllResponse>
  }
  type MarkAllContext = {
    snapshot?: AttentionIntent
  }
  type Original = ReturnType<typeof origin.begin>["token"]
  const mutation = useMutation<DomainResult[], Error, Original, MarkAllContext>({ meta: { observabilityAction: "inbox.read_all" },
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
        snapshot: registry ? clearAttentionOptimistically(registry) : undefined,
      }
    },
    onSuccess: async (results, original, context) => {
      origin.assert(original)
      let targetRevision = 0
      let firstFailure: unknown
      const failedDomains = new Set<AttentionDomain>()
      for (const { domain, result } of results) {
        if (result.status === "fulfilled") {
          targetRevision = Math.max(targetRevision, result.value?.revision ?? 0)
        } else {
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
      if (firstFailure) toastApiError(firstFailure, "Some inbox items could not be marked read")
      void reconcileAccountReadState(queryClient, {
        targetRevision,
      }).catch(() => undefined)
    },
    onError: (e, original, context) => {
      const registry = origin.registry
      if (registry && context?.snapshot) {
        restoreAttentionOptimisticSnapshot(registry, context.snapshot)
      }
      try { origin.assert(original) } catch { return }
      if (isAbortError(e)) return
      if (registry) void reconcileAccountAttention(registry).catch(() => undefined)
      toastApiError(e, "Failed to mark inbox read")
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
  type Original = ReturnType<typeof origin.begin>["token"]
  const mutation = useMutation<
    { revision: number },
    Error,
    { input: DeleteMentionArgs; original: Original },
    {
      attentionSnapshot?: AttentionIntent
    }
  >({ meta: { observabilityAction: "mention.dismiss" },
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
      const attentionSnapshot = registry
        ? removeAttentionItemsOptimistically(
            registry,
            (item) => (
              item.sourceId === args.mentionId
              && (item.kind === "mention" || item.kind === "reply")
            ),
          )
        : undefined
      return { attentionSnapshot }
    },
    onSuccess: async (result, { original }, context) => {
      origin.assert(original)
      const registry = origin.registry
      if (registry && context.attentionSnapshot) {
        await commitAttentionItemsOptimisticSnapshot(registry, context.attentionSnapshot)
        origin.assert(original)
        void reconcileAccountAttention(registry).catch(() => undefined)
      }

    },
    onError: (err, { original }, ctx) => {
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
