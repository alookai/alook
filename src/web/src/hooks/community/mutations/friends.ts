"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { FriendsResponse } from "@/hooks/community/use-friends"

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

// ── Accept / reject / remove — all decorate the pending list ───────────────

export type FriendActionArgs = { friendshipId: string }

function useFriendListMutation(
  buildFetch: (id: string) => Promise<unknown>,
  patchOptimistic: (prev: FriendsResponse | undefined, id: string) => FriendsResponse | undefined,
) {
  const queryClient = useQueryClient()
  return useMutation<void, Error, FriendActionArgs, { snapshot: FriendsResponse | undefined }>({
    mutationFn: async ({ friendshipId }) => {
      await buildFetch(friendshipId)
    },
    onMutate: async (args) => {
      const key = communityKeys.friends()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<FriendsResponse>(key)
      queryClient.setQueryData<FriendsResponse | undefined>(key, (prev) =>
        patchOptimistic(prev, args.friendshipId),
      )
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.friends(), ctx.snapshot)
    },
    onSuccess: () => {
      // Reconcile once — the accepted friendship needs the "accepted" row from
      // the server. Invalidation refetches. If the WS event arrives first, the
      // reconciliation table also invalidates; either way, the final render is
      // the same.
      void queryClient.invalidateQueries({ queryKey: communityKeys.friends() })
    },
  })
}

export function useAcceptFriendRequest() {
  return useFriendListMutation(
    (id) => apiFetch(`/api/community/friends/${id}/accept`, { method: "POST" }),
    (prev, id) =>
      prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== id) } : prev,
  )
}

export function useRejectFriendRequest() {
  return useFriendListMutation(
    (id) => apiFetch(`/api/community/friends/${id}/reject`, { method: "POST" }),
    (prev, id) =>
      prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== id) } : prev,
  )
}

export function useRemoveFriend() {
  return useFriendListMutation(
    (id) => apiFetch(`/api/community/friends/${id}`, { method: "DELETE" }),
    (prev, id) =>
      prev ? { ...prev, friends: prev.friends.filter((f) => f.id !== id) } : prev,
  )
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
