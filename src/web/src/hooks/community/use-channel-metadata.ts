"use client"

import { useMemo } from "react"
import { useSelector } from "@tanstack/react-store"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { useQueryClient } from "@tanstack/react-query"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { forumTagFromUrl } from "@/lib/community/forum-tag-selection"
import { useStoredForumTag } from "./use-stored-forum-tag"
import { useConversationResource } from "./use-conversation-entry"

type ChannelReadingStatus = "no-target" | "pending" | "readable" | "denied" | "unresolved" | "retryable-error"

export function useChannelMetadata(serverId: string | null, channelId: string | undefined, intent?: { anchorMessageId?: string | null; tag?: string | null }) {
  const client = useQueryClient()
  const canonicalType = channelId ? getCommunityDbRegistry(client)?.collections.channels.get(channelId)?.type : undefined
  const forumSelection = serverId !== null && (!canonicalType || canonicalType === "forum")
  const storedTag = useStoredForumTag(forumSelection ? channelId ?? null : null)
  const selectedTag = forumSelection ? forumTagFromUrl(intent?.tag) ?? storedTag : intent?.tag ?? "All"
  const tag = selectedTag === "All" ? null : selectedTag
  const entry = useConversationResource(channelId ? { channelId, serverId, ...intent, tag } : null, null, false, "metadata", selectedTag !== null)
  const { query, canonical, scope, canRead, windowReady, revoked, denied } = entry
  const runtime = useCommunityRuntime()
  const denialCode = useSelector(runtime.ws, state => {
    const current = channelId ? state.channelAccessScopes.get(channelId) : undefined
    return revoked && current?.revoked && current.serverId === serverId ? current.denialCode : undefined
  })
  const identityKnown = canRead && !!scope && !!canonical && canonical.id === channelId && canonical.serverId === serverId && !canonical.pending
  const error = entry.verificationError
  const status: ChannelReadingStatus = !channelId ? "no-target" : denied ? "denied" : windowReady ? "readable"
    : error || entry.verificationFailed ? "retryable-error" : query.isFetching || entry.verificationPending ? "pending" : "unresolved"
  const data = useMemo(() => {
    if (!identityKnown || !canonical || !scope) return undefined
    return { ...canonical, serverId,
    createdAt: canonical.createdAt ?? "", name: canonical.name ?? "",
    verifiedEpoch: scope.proof.accessEpoch, identityProof: scope.proof, readProof: scope.proof,
    parentChannelId: canonical.parentChannelId ?? null, parentMessageId: canonical.parentMessageId ?? null,
    creatorId: canonical.creatorId ?? null, lastMessageAt: canonical.lastMessageAt ?? null,
  } }, [canonical, identityKnown, scope, serverId])
  return { ...query, error, data, status, identityKnown, canRead, windowReady, displayWindow: entry.displayWindow, isVerified: canRead,
    isArchived: !!canonical?.archived, denied, revoked, denialCode, canonical,
    retry: entry.retryVerification, retrying: entry.verificationFetching,
  }
}
