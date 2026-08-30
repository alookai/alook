"use client"

import { useEffect, useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetchProfiles, communityUserProfilePatch } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"

export type ReactionDetailsProfile = {
  id: string
  name: string
  discriminator: string
  avatar: string
  avatarVersion: number
}

export type ReactionDetailsEnvelope = {
  messageId: string
  scope:
    | { kind: "server"; serverId: string; channelId: string }
    | { kind: "dm"; channelId: string }
  actors: Array<{
    userId: string
    profile: ReactionDetailsProfile | null
  }>
}

const loadReactionDetails = (messageId: string) =>
  apiFetchProfiles<ReactionDetailsEnvelope>(
    `/api/community/messages/${messageId}/reactions`,
    (data) => data.actors.flatMap((actor) => actor.profile
      ? [communityUserProfilePatch(actor.userId, actor.profile)]
      : []),
  )

export function useReactionDetails({
  messageId,
  open,
  userIds,
}: {
  messageId: string
  open: boolean
  userIds: readonly string[]
}) {
  const uniqueUserIds = useMemo(() => [...new Set(userIds)], [userIds])
  const attemptedRef = useRef(new Set<string>())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const query = useQuery({
    queryKey: communityKeys.reactionDetails(messageId),
    queryFn: () => loadReactionDetails(messageId),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const { data, isFetching, refetch } = query

  useEffect(() => {
    const current = new Set(uniqueUserIds)
    for (const attempted of attemptedRef.current) {
      if (!current.has(attempted)) attemptedRef.current.delete(attempted)
    }
    if (!open || !data || isFetching) return
    const known = new Set(data.actors.map((actor) => actor.userId))
    const unknown = uniqueUserIds.filter((id) =>
      !known.has(id) && !attemptedRef.current.has(id))
    if (unknown.length === 0) return
    unknown.forEach((id) => attemptedRef.current.add(id))

    const refresh = async () => {
      timerRef.current = null
      await refetch()
    }
    timerRef.current = setTimeout(refresh, 100)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [data, isFetching, open, refetch, uniqueUserIds])

  return query
}
