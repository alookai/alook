"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { FriendsResponse } from "@/hooks/community/use-friends"
import type { UnreadsResponse } from "@/hooks/community/use-inbox"
import type { PendingRequest } from "@/lib/community/models/people"
import type { InboxFriendRequest } from "@/lib/community/models/inbox"
import {
  getFriendRequestActionController,
  type FriendRequestAction,
} from "@/hooks/community/use-friend-request-action-state"

/**
 * Friend-scoped mutations. All six live on one query key
 * (`communityKeys.friends()`), so success handlers just invalidate that key
 * — server WS `community:friend.*` also invalidates it, but the same-tab UX
 * still needs the mutating tab to react before the WS round-trip.
 *
 * Optimistic paths are limited to the three that visibly disappear from the
 * pending list (accept/reject) or list (remove/block/unblock). Send-request
 * doesn't get an optimistic outgoing entry because the response includes the
 * canonical id we'd need to reconcile.
 */

// ── Send friend request ────────────────────────────────────────────────────

export type SendFriendRequestArgs = { username?: string; userId?: string }

export function useSendFriendRequest() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, SendFriendRequestArgs>({
    mutationFn: async ({ username, userId }) => {
      await apiFetch("/api/community/friends/request", {
        method: "POST",
        body: JSON.stringify({ userId, username }),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}

// ── Accept / reject ────────────────────────────────────────────────────────

export type FriendActionArgs = { friendshipId: string }

type CapturedRow<T> = { row: T; index: number }
type FriendRequestMutationContext = {
  friends?: CapturedRow<PendingRequest>
  generation: number
  inbox?: CapturedRow<InboxFriendRequest>
}

function captureRow<T extends { id: string }>(
  rows: readonly T[],
  id: string,
): CapturedRow<T> | undefined {
  const index = rows.findIndex((row) => row.id === id)
  return index < 0 ? undefined : { row: rows[index]!, index }
}

function reinsertRow<T extends { id: string }>(
  rows: readonly T[],
  captured: CapturedRow<T> | undefined,
): T[] {
  if (!captured || rows.some((row) => row.id === captured.row.id)) return [...rows]
  const next = [...rows]
  next.splice(Math.min(captured.index, next.length), 0, captured.row)
  return next
}

function useFriendRequestMutation(
  action: FriendRequestAction,
  buildFetch: (id: string) => Promise<unknown>,
) {
  const queryClient = useQueryClient()
  const controller = getFriendRequestActionController(queryClient)
  return useMutation<void, Error, FriendActionArgs, FriendRequestMutationContext>({
    mutationFn: async ({ friendshipId }) => {
      await buildFetch(friendshipId)
    },
    onMutate: async ({ friendshipId }) => {
      const generation = controller.claimMutation(friendshipId, action)
      const friendsKey = communityKeys.friends()
      const inboxKey = communityKeys.inboxUnreads()
      await Promise.all([
        queryClient.cancelQueries({ queryKey: friendsKey, exact: true }),
        queryClient.cancelQueries({ queryKey: inboxKey, exact: true }),
      ])
      const friends = queryClient.getQueryData<FriendsResponse>(friendsKey)
      const inbox = queryClient.getQueryData<UnreadsResponse>(inboxKey)
      const context = {
        friends: captureRow(friends?.pending ?? [], friendshipId),
        generation,
        inbox: captureRow(inbox?.friendRequests ?? [], friendshipId),
      }
      queryClient.setQueryData<FriendsResponse | undefined>(friendsKey, (current) =>
        current
          ? { ...current, pending: current.pending.filter((row) => row.id !== friendshipId) }
          : current,
      )
      queryClient.setQueryData<UnreadsResponse | undefined>(inboxKey, (current) =>
        current
          ? {
              ...current,
              friendRequests: (current.friendRequests ?? []).filter((row) => row.id !== friendshipId),
            }
          : current,
      )
      return context
    },
    onSuccess: async (_data, { friendshipId }, context) => {
      if (!context) return
      await controller.publishTerminalAndFence(friendshipId, context.generation)
    },
    onError: (_error, { friendshipId }, context) => {
      if (!context) return
      if (!controller.isCompensatable(friendshipId, context.generation)) return
      queryClient.setQueryData<FriendsResponse | undefined>(communityKeys.friends(), (current) =>
        current
          ? { ...current, pending: reinsertRow(current.pending, context?.friends) }
          : current,
      )
      queryClient.setQueryData<UnreadsResponse | undefined>(communityKeys.inboxUnreads(), (current) =>
        current
          ? { ...current, friendRequests: reinsertRow(current.friendRequests ?? [], context?.inbox) }
          : current,
      )
      controller.publishError(friendshipId, context.generation)
    },
    onSettled: async (_data, _error, { friendshipId }, context) => {
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: communityKeys.friends(), exact: true }),
          queryClient.invalidateQueries({ queryKey: communityKeys.inboxUnreads(), exact: true }),
        ])
      } finally {
        if (context) controller.settleGeneration(friendshipId, context.generation)
      }
    },
  })
}

export function useAcceptFriendRequest() {
  return useFriendRequestMutation(
    "accept",
    (id) => apiFetch(`/api/community/friends/${id}/accept`, { method: "POST" }),
  )
}

export function useRejectFriendRequest() {
  return useFriendRequestMutation(
    "reject",
    (id) => apiFetch(`/api/community/friends/${id}/reject`, { method: "POST" }),
  )
}

// ── Remove friend ──────────────────────────────────────────────────────────

export function useRemoveFriend() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, FriendActionArgs, { snapshot: FriendsResponse | undefined }>({
    mutationFn: async ({ friendshipId }) => {
      await apiFetch(`/api/community/friends/${friendshipId}`, { method: "DELETE" })
    },
    onMutate: async ({ friendshipId }) => {
      const key = communityKeys.friends()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FriendsResponse>(key)
      queryClient.setQueryData<FriendsResponse | undefined>(key, (current) =>
        current
          ? { ...current, friends: current.friends.filter((friend) => friend.id !== friendshipId) }
          : current,
      )
      return { snapshot }
    },
    onError: (_error, _args, context) => {
      if (context?.snapshot) queryClient.setQueryData(communityKeys.friends(), context.snapshot)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}

// ── Cancel outgoing pending (unified) ──────────────────────────────────────
//
// After the friendship-unification migration (0065) bot friend-requests are
// real community_friendship rows, so cancelling one is the same DELETE the
// requester (or the bot's owner) uses for any pending outgoing row.

export type CancelBotFriendRequestArgs = { requestId: string }

export function useCancelBotFriendRequest() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, CancelBotFriendRequestArgs, { snapshot: FriendsResponse | undefined }>({
    mutationFn: async ({ requestId }) => {
      await apiFetch(`/api/community/friends/${requestId}`, { method: "DELETE" })
    },
    onMutate: async ({ requestId }) => {
      const key = communityKeys.friends()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FriendsResponse>(key)
      queryClient.setQueryData<FriendsResponse | undefined>(key, (prev) =>
        prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.friends(), ctx.snapshot)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}

// ── Owner decision (approve / deny a gated friend row from a DM card) ────────

export type OwnerDecisionArgs = { friendshipId: string; decision: "approve" | "deny" }

export function useOwnerDecision() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, OwnerDecisionArgs>({
    mutationFn: async ({ friendshipId, decision }) => {
      await apiFetch(`/api/community/friends/${friendshipId}/owner-decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}

// ── Block / unblock ────────────────────────────────────────────────────────

export type BlockUserArgs = { userId: string }

export function useBlockUser() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, BlockUserArgs>({
    mutationFn: async ({ userId }) => {
      await apiFetch(`/api/community/users/${userId}/block`, { method: "POST" })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}

export function useUnblockUser() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, BlockUserArgs, { snapshot: FriendsResponse | undefined }>({
    mutationFn: async ({ userId }) => {
      await apiFetch(`/api/community/users/${userId}/unblock`, { method: "POST" })
    },
    onMutate: async (args) => {
      const key = communityKeys.friends()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FriendsResponse>(key)
      queryClient.setQueryData<FriendsResponse | undefined>(key, (prev) =>
        prev
          ? {
              ...prev,
              blocked: prev.blocked.filter(
                (b) => (b.userId ?? b.id) !== args.userId,
              ),
            }
          : prev,
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.friends(), ctx.snapshot)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}
