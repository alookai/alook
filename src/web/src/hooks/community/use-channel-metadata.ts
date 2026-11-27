"use client"

import { useMemo } from "react"
import { useSelector } from "@tanstack/react-store"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { useQueryClient } from "@tanstack/react-query"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { forumTagFromUrl } from "@/lib/community/forum-tag-selection"
import { useStoredForumTag } from "./use-stored-forum-tag"
import { useSharedConversationResource } from "./use-conversation-entry"

type ChannelReadingStatus = "no-target" | "pending" | "readable" | "denied" | "unresolved" | "retryable-error"

export function useChannelMetadata(serverId: string | null, channelId: string | undefined, intent?: { anchorMessageId?: string | null; tag?: string | null }) {
  const client = useQueryClient()
  const canonicalType = channelId ? getCommunityDbRegistry(client)?.collections.channels.get(channelId)?.type : undefined
  const forumSelection = serverId !== null && (!canonicalType || canonicalType === "forum")
  const storedTag = useStoredForumTag(forumSelection ? channelId ?? null : null)
  const selectedTag = forumSelection ? forumTagFromUrl(intent?.tag) ?? storedTag : intent?.tag ?? "All"
  const tag = selectedTag === "All" ? null : selectedTag
  const anchorMessageId = intent?.anchorMessageId
  const target = useMemo(
    () => (channelId ? { channelId, serverId, anchorMessageId, tag } : null),
    [anchorMessageId, channelId, serverId, tag],
  )
  const entry = useSharedConversationResource(target, null, "metadata", selectedTag !== null)
  const resource = entry.value
  const query = resource.query
  const canonical = resource.canonical
  const scope = resource.scope
  const canRead = resource.canRead
  const windowReady = resource.windowReady
  const revoked = resource.revoked
  const denied = resource.denied
  const runtime = useCommunityRuntime()
  const denialCode = useSelector(runtime.ws, state => {
    const current = channelId ? state.channelAccessScopes.get(channelId) : undefined
    return revoked && current?.revoked && current.serverId === serverId ? current.denialCode : undefined
  })
  const identityKnown = canRead && !!scope && !!canonical && canonical.id === channelId && canonical.serverId === serverId && !canonical.pending
  const error = resource.verificationError
  const status: ChannelReadingStatus = !channelId ? "no-target" : denied ? "denied" : canRead && resource.displayWindow !== undefined ? "readable"
    : error || resource.verificationFailed ? "retryable-error" : query.isFetching || resource.verificationPending ? "pending" : "unresolved"
  const data = useMemo(() => {
    if (!identityKnown || !canonical || !scope) return undefined
    return { ...canonical, serverId,
    createdAt: canonical.createdAt ?? "", name: canonical.name ?? "",
    verifiedEpoch: scope.proof.accessEpoch, identityProof: scope.proof, readProof: scope.proof,
    parentChannelId: canonical.parentChannelId ?? null, parentMessageId: canonical.parentMessageId ?? null,
    creatorId: canonical.creatorId ?? null, lastMessageAt: canonical.lastMessageAt ?? null,
  } }, [canonical, identityKnown, scope, serverId])
  return { ...query, error, data, status, identityKnown, canRead, windowReady, displayWindow: resource.displayWindow, isVerified: canRead,
    isArchived: !!canonical?.archived, denied, revoked, denialCode, canonical,
    retry: resource.retryVerification, retrying: resource.verificationFetching,
    sharedResource: entry.shared,
  }
}
