"use client"

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

export type ThreadParticipant = {
  userId: string
  name: string | null
  discriminator: string | null
  avatar: string
  source: "mention" | "spoke" | "added"
  muted: boolean
}

const EMPTY: readonly ThreadParticipant[] = Object.freeze([])

/** A thread's notify participants (incl. muted rows). */
export function useThreadParticipants(
  channelId: string,
  enabled = true,
): UseQueryResult<{ participants: ThreadParticipant[] }> & { participants: ThreadParticipant[] } {
  const query = useQuery({
    queryKey: communityKeys.threadParticipants(channelId),
    queryFn: () =>
      apiFetch<{ participants: ThreadParticipant[] }>(
        `/api/community/channels/${encodeURIComponent(channelId)}/participants`,
      ),
    enabled: enabled && !!channelId,
  })
  return { ...query, participants: query.data?.participants ?? (EMPTY as ThreadParticipant[]) }
}

/** Owner adds a parent-channel member to the thread. */
export function useAddThreadParticipant(channelId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/api/community/channels/${encodeURIComponent(channelId)}/participants`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: communityKeys.threadParticipants(channelId) })
    },
  })
}

/** Leave a thread (remove your own participation, or the creator removes someone). */
export function useRemoveThreadParticipant(channelId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(
        `/api/community/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: communityKeys.threadParticipants(channelId) })
    },
  })
}

/** Mute / unmute the viewer's own thread notifications. */
export function useSetThreadParticipantMuted(channelId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, muted }: { userId: string; muted: boolean }) =>
      apiFetch(
        `/api/community/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}`,
        { method: "PATCH", body: JSON.stringify({ muted }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: communityKeys.threadParticipants(channelId) })
    },
  })
}
