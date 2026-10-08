import { apiFetch } from "@/lib/api/client"
import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { retryConversationRead, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, publishCommunityChannelMetadata, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { normalizeCommunityChannelIdentity, type CommunityChannelIdentity, type CommunityAccessDecision } from "@alook/shared"

export type ChannelMetadata = CommunityChannelIdentity & {
  readContractVersion?: 2
  accessDecision?: CommunityAccessDecision
}

export function captureChannelMetadataToken(queryClient: QueryClient, channelId: string) {
  return captureCommunityLiveSnapshotToken(queryClient, channelId)
}

export function isChannelMetadataTokenCurrent(token: ReturnType<typeof captureChannelMetadataToken>) {
  try {
    assertCommunityLiveSnapshotTokenCurrent(token.queryClient, token, undefined)
    return true
  } catch { return false }
}

export type ChannelMetadataResource = Pick<CommunityChannelIdentity, "id"> & Partial<Pick<CommunityChannelIdentity, "serverId">> & {
  identityProof?: ReturnType<typeof captureChannelMetadataToken>
  readProof?: ReturnType<typeof captureChannelMetadataToken>
}

export async function fetchChannelMetadata(
  queryClient: QueryClient,
  serverId: string | null,
  channelId: string,
  signal?: AbortSignal,
  token = captureChannelMetadataToken(queryClient, channelId),
) {
  return withConversationReadDeadline(signal, async (readSignal) => {
    const queryKey = communityKeys.channelMeta(serverId, channelId)
    const resource = queryClient.getQueryCache().find({ queryKey, exact: true })
    const assertActive = () => {
      if (readSignal.aborted || !isChannelMetadataTokenCurrent(token)
        || resource && queryClient.getQueryCache().find({ queryKey, exact: true }) !== resource) throw new DOMException("Stale channel metadata", "AbortError")
    }
    assertActive()
    await token.registry!.ready
    assertActive()
    await token.registry!.collections.channels.preload()
    assertActive()
    let meta: ChannelMetadata
    try {
      const response = await apiFetch<ChannelMetadata>(`/api/community/channels/${encodeURIComponent(channelId)}`, communityRequestOptions(queryClient, token, readSignal, assertActive))
      meta = { ...response, ...normalizeCommunityChannelIdentity(response) }
      assertActive()
    } catch (error) {
      assertActive()
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        retireCommunityChannelReading(token.registry!, channelId, { reason: "read-denied", serverId, preserveQuery: resource })
      }
      throw error
    }
    if (meta.id !== channelId || meta.serverId !== serverId
      || !(serverId === null ? meta.type === "dm" : ["text", "forum", "thread"].includes(meta.type))
      || !(typeof meta.name === "string" || (serverId === null && meta.name === null))) throw new Error("Channel metadata scope mismatch")
    if (meta.parentChannelId && (token.registry!.runtime.ws.get().channelAccessScopes.get(meta.parentChannelId)?.generation ?? 0) !== (token.channelScopes.get(meta.parentChannelId)?.generation ?? 0)) throw new DOMException("Retired parent channel", "AbortError")
    if (!meta.archived && (meta.readContractVersion !== 2 || meta.accessDecision?.canRead === true)) {
      if (serverId) token.registry!.runtime.ws.actions.grantServerAccess(serverId)
      token.registry!.runtime.ws.actions.rememberChannelAccess(serverId, channelId, meta.parentChannelId)
    }
    return { ...meta, name: meta.name ?? "",
      activityAt: meta.lastMessageAt ?? meta.createdAt ?? "", identityProof: token }
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
      const canRead = !metadata.archived && (metadata.readContractVersion !== 2 || metadata.accessDecision?.canRead === true)
      if (!canRead) retireCommunityChannelReading(token.registry!, channelId, { reason: "read-denied", serverId, preserveQuery: queryClient.getQueryCache().find({ queryKey, exact: true }) })
      const qualified = captureChannelMetadataToken(queryClient, channelId)
      return { id: metadata.id, serverId: metadata.serverId, identityProof: qualified, readProof: canRead ? qualified : undefined }
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: retryConversationRead,
    networkMode: "always",
  })
}
