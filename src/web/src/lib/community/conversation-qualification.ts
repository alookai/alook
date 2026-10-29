import type { QueryClient } from "@tanstack/react-query"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

export type ConversationListScope = {
  proof: ReturnType<typeof captureChannelMetadataToken>
  tag: string | null
}

export function conversationListScopeKey({ proof, tag }: ConversationListScope) {
  const channelId = proof.channelId!
  const parentId = proof.channelLineage?.parentChannelId
  return [proof.viewerId, channelId, tag, proof.accountEpoch, proof.accessEpoch, proof.ownerGeneration,
    proof.channelScopes.get(channelId)?.generation ?? 0,
    parentId ?? null, parentId ? proof.channelScopes.get(parentId)?.generation ?? 0 : 0] as const
}

export function captureChannelMetadataToken(client: QueryClient, channelId: string) {
  return captureCommunityLiveSnapshotToken(client, channelId)
}

export function isChannelMetadataTokenCurrent(token: ReturnType<typeof captureChannelMetadataToken>) {
  try { assertCommunityLiveSnapshotTokenCurrent(token.queryClient, token, undefined); return true }
  catch { return false }
}
