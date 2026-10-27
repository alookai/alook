"use client"

import { useMemo } from "react"
import { useConversationResource } from "./use-conversation-entry"

type ChannelReadingStatus = "no-target" | "pending" | "readable" | "denied" | "unresolved" | "retryable-error"

export function useChannelMetadata(serverId: string | null, channelId: string | undefined, intent?: { anchorMessageId?: string | null; tag?: string | null }) {
  const entry = useConversationResource(channelId ? { channelId, serverId, ...intent } : null)
  const { query, canonical, scope, canRead, revoked, denied } = entry
  const identityKnown = canRead && !!scope && !!canonical && canonical.id === channelId && canonical.serverId === serverId && !canonical.pending && canonical.resourceComplete === true
  const error = entry.verificationError
  const status: ChannelReadingStatus = !channelId ? "no-target" : denied ? "denied" : canRead ? "readable"
    : error || entry.verificationFailed ? "retryable-error" : query.isFetching || entry.verificationPending ? "pending" : "unresolved"
  const data = useMemo(() => {
    if (!identityKnown || !canonical || canonical.resourceComplete !== true || !scope) return undefined
    return { ...canonical, serverId,
    createdAt: canonical.createdAt ?? "", name: canonical.name ?? "",
    verifiedEpoch: scope.proof.accessEpoch, identityProof: scope.proof, readProof: scope.proof,
    parentChannelId: canonical.parentChannelId ?? null, parentMessageId: canonical.parentMessageId ?? null,
    creatorId: canonical.creatorId ?? null, lastMessageAt: canonical.lastMessageAt ?? null,
  } }, [canonical, identityKnown, scope, serverId])
  return { ...query, error, data, status, identityKnown, canRead, isVerified: canRead,
    isArchived: canonical?.resourceComplete === true && !!canonical.archived, denied, revoked, canonical,
    retry: entry.retryVerification, retrying: entry.verificationFetching,
  }
}
