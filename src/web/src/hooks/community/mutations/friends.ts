"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useCommunityCommandMutation } from "../use-community-command-mutation"
import { beginCommunityCommandRevision, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { reconcileAccountAttention } from "../use-account-attention"
import { useCommunityMutationOrigin } from "../community-origin"
import { communityKeys } from "@/lib/query-keys"
import { publishCommunityFriendBlock, publishCommunityFriendDecision, removeSettledCommunityFriendCommands } from "@/lib/community-db/sync"
import { isAbortError } from "@/lib/errors"

export type SendFriendRequestArgs = { username?: string; userId?: string }
export type FriendActionArgs = { friendshipId: string }
export type CancelBotFriendRequestArgs = { requestId: string }
export type OwnerDecisionArgs = { friendshipId: string; decision: "approve" | "deny" }
export type BlockUserArgs = { userId: string }
type Command = { path: string; method: "POST" | "DELETE"; body?: string; friendshipId?: string; decision?: "accept" | "reject" | "remove"; userId?: string; blocked?: boolean; removeOptimistically?: boolean }

function useFriendCommand<Args extends object>(action: string, build: (args: Args) => Command) {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, Args>(origin, {
    mutationKey: action === "accept" || action === "reject" ? ["community", "friend-request", action] : ["community", "friends", action],
    gcTime: action === "accept" || action === "reject" ? Infinity : 0,
    onMutate: (args) => {
      origin.assert(args.original)
      const id = build(args).friendshipId
      if (id) removeSettledCommunityFriendCommands(queryClient, [id])
    },
    mutationFn: async (args) => {
      const command = build(args), original = args.original, registry = origin.registry
      origin.assert(original)
      await registry?.ready
      origin.assert(original)
      await Promise.all([registry!.collections.friendships.preload(), registry!.collections.attentionItems.preload()])
      await Promise.all([queryClient.cancelQueries({ queryKey: communityKeys.friends(), exact: true, predicate: (query) => args.resources.includes(query) }), queryClient.cancelQueries({ queryKey: communityKeys.accountAttention(), exact: true, predicate: (query) => args.resources.includes(query) })])
      origin.assert(original)
      const token = beginCommunityCommandRevision(queryClient, original)
      const persist = async () => {
        await origin.request(token, command.path, { method: command.method, ...(command.body ? { body: command.body } : {}) })
        if (command.friendshipId && command.decision) publishCommunityFriendDecision(queryClient, command.friendshipId, command.decision, { token })
        if (command.userId && command.blocked !== undefined) publishCommunityFriendBlock(queryClient, command.userId, command.blocked, { token })
      }
      const transaction = registry!.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      transaction.mutate(() => {
        const removeIds = Array.from(registry!.collections.friendships.values()).filter((row) => command.userId ? row.userId === command.userId && (command.blocked === true || row.kind === "blocked") : command.removeOptimistically && row.id === command.friendshipId).map((row) => row.id)
        if (removeIds.length) registry!.collections.friendships.delete(removeIds)
        const attentionIds = Array.from(registry!.collections.attentionItems.values()).filter((row) => row.kind === "friend_request" && (command.userId ? command.blocked === true && row.actorUserId === command.userId : command.removeOptimistically && row.sourceId === command.friendshipId)).map((row) => row.id)
        if (attentionIds.length) registry!.collections.attentionItems.delete(attentionIds)
      })
      try { if (transaction.mutations.length) await transaction.commit(); else await persist() } catch (error) { origin.assert(original); throw error }
      origin.assert(original)
    },
    onSuccess: (_data, args) => {
      if (action === "accept" || action === "reject") void reconcileAccountAttention(origin.registry!).catch(() => undefined)
      else void queryClient.invalidateQueries({ queryKey: communityKeys.accountAttention(), exact: true, predicate: (query) => args.resources.includes(query) }, { cancelRefetch: false }).catch(() => undefined)
    },
    onError: (_error, args) => {
      if ((action === "accept" || action === "reject") && captureCommunityLiveSnapshotToken(queryClient).canonicalRevision > args.original.canonicalRevision) void reconcileAccountAttention(origin.registry!).catch(() => undefined)
    },
    onSettled: async (_data, error, args) => {
      await queryClient.invalidateQueries({ queryKey: communityKeys.friends(), exact: true, predicate: (query) => args.resources.includes(query) }, { cancelRefetch: false })
      origin.assert(args.original)
      const id = build(args).friendshipId
      const row = id ? origin.registry!.collections.friendships.get(id) : undefined
      if (!error || isAbortError(error) || (row?.kind !== "incoming" && row?.kind !== "outgoing")) {
        for (const mutation of queryClient.getMutationCache().findAll({ mutationKey: ["community", "friend-request"], predicate: (entry) => entry.state.variables === args })) queryClient.getMutationCache().remove(mutation)
      }
    },
  })
}

export function useSendFriendRequest() { return useFriendCommand<SendFriendRequestArgs>("send", ({ username, userId }) => ({ path: "/api/community/friends/request", method: "POST", body: JSON.stringify({ username, userId }) })) }
export function useAcceptFriendRequest() { return useFriendCommand<FriendActionArgs>("accept", ({ friendshipId }) => ({ path: `/api/community/friends/${friendshipId}/accept`, method: "POST", friendshipId, decision: "accept" })) }
export function useRejectFriendRequest() { return useFriendCommand<FriendActionArgs>("reject", ({ friendshipId }) => ({ path: `/api/community/friends/${friendshipId}/reject`, method: "POST", friendshipId, decision: "reject" })) }
export function useRemoveFriend() { return useFriendCommand<FriendActionArgs>("remove", ({ friendshipId }) => ({ path: `/api/community/friends/${friendshipId}`, method: "DELETE", friendshipId, decision: "remove", removeOptimistically: true })) }
export function useCancelBotFriendRequest() { return useFriendCommand<CancelBotFriendRequestArgs>("cancel", ({ requestId }) => ({ path: `/api/community/friends/${requestId}`, method: "DELETE", friendshipId: requestId, decision: "remove", removeOptimistically: true })) }
export function useOwnerDecision() { return useFriendCommand<OwnerDecisionArgs>("owner-decision", ({ friendshipId, decision }) => ({ path: `/api/community/friends/${friendshipId}/owner-decision`, method: "POST", body: JSON.stringify({ decision }), friendshipId, ...(decision === "deny" ? { decision: "reject" as const } : {}) })) }
export function useBlockUser() { return useFriendCommand<BlockUserArgs>("block", ({ userId }) => ({ path: `/api/community/users/${userId}/block`, method: "POST", userId, blocked: true })) }
export function useUnblockUser() { return useFriendCommand<BlockUserArgs>("unblock", ({ userId }) => ({ path: `/api/community/users/${userId}/unblock`, method: "POST", userId, blocked: false })) }
