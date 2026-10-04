import { apiFetch } from "@/lib/api/client"
import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { retryConversationRead, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, publishCommunityChannelMetadata } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

export type ChannelMetadata = {
  id: string
  serverId: string | null
  name: string | null
  type: string
  parentChannelId: string | null
  parentMessageId: string | null
  creatorId: string | null
  archived: boolean | number
  lastMessageAt: string | null
  createdAt: string
}

export function captureChannelMetadataToken(queryClient: QueryClient, channelId: string) {
  const owner = captureCommunityLiveSnapshotToken(queryClient)
  return { ...owner, channelId, generation: owner.registry!.runtime.ws.get().channelAccessScopes.get(channelId)?.generation ?? 0 }
}

export function isChannelMetadataTokenCurrent(token: ReturnType<typeof captureChannelMetadataToken>) {
  try {
    assertCommunityLiveSnapshotTokenCurrent(token.queryClient, token, undefined)
    return (token.registry!.runtime.ws.get().channelAccessScopes.get(token.channelId)?.generation ?? 0) === token.generation
  } catch { return false }
}

export type ChannelMetadataResource = {
  id: string
  verifiedEpoch: number
  verification?: ReturnType<typeof captureChannelMetadataToken>
  historyVerification?: ReturnType<typeof captureChannelMetadataToken>
}

export async function fetchChannelMetadata(
  queryClient: QueryClient,
  serverId: string | null,
  channelId: string,
  signal?: AbortSignal,
  token = captureChannelMetadataToken(queryClient, channelId),
) {
  return withConversationReadDeadline(signal, async (readSignal) => {
    const assertActive = () => {
      if (readSignal.aborted || !isChannelMetadataTokenCurrent(token)) throw new DOMException("Stale channel metadata", "AbortError")
    }
    assertActive()
    await token.registry!.ready
    assertActive()
    await token.registry!.collections.channels.preload()
    assertActive()
    let meta: ChannelMetadata
    try {
      meta = await apiFetch<ChannelMetadata>(`/api/community/channels/${encodeURIComponent(channelId)}`, communityRequestOptions(queryClient, token, readSignal, assertActive))
      assertActive()
    } catch (error) { assertActive(); throw error }
    if (meta.id !== channelId || meta.serverId !== serverId
      || !(serverId === null ? meta.type === "dm" : ["text", "forum", "thread"].includes(meta.type))
      || !(typeof meta.name === "string" || (serverId === null && meta.name === null))) throw new Error("Channel metadata scope mismatch")
    if (serverId !== null) {
      token.registry!.runtime.ws.actions.grantServerAccess(serverId)
      token.registry!.runtime.ws.actions.rememberChannelAccess(serverId, channelId, meta.parentChannelId)
    }
    return { ...meta, name: meta.name ?? "", archived: meta.archived === true || meta.archived === 1,
      activityAt: meta.lastMessageAt ?? meta.createdAt, verifiedEpoch: token.accessEpoch, verification: token }
  })
}

export function channelMetadataOptions(queryClient: QueryClient, serverId: string | null, channelId: string) {
  const queryKey = communityKeys.channelMeta(serverId, channelId)
  return queryOptions({
    queryKey,
    queryFn: async ({ signal }): Promise<ChannelMetadataResource> => {
      const token = captureChannelMetadataToken(queryClient, channelId)
      const metadata = await fetchChannelMetadata(queryClient, serverId, channelId, signal, token)
      publishCommunityChannelMetadata(queryClient, { metadata, proof: { token, signal } })
      const previous = queryClient.getQueryData<ChannelMetadataResource>(queryKey)
      return { id: metadata.id, verifiedEpoch: token.accessEpoch, verification: token, historyVerification: previous?.historyVerification }
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: retryConversationRead,
    networkMode: "always",
  })
}
