import { apiFetch } from "@/lib/api/client"
import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { retryConversationRead, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, publishCommunityChannelMetadata, purgeCommunityChannel } from "@/lib/community-db/sync"
import { ApiError } from "@/lib/errors"
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
  readContractVersion?: 2
  accessDecision?: { channelId: string; canRead: boolean; canSend: boolean; canCreateDiscussion: boolean }
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
  serverId?: string | null
  verifiedEpoch: number
  verification?: ReturnType<typeof captureChannelMetadataToken>
  historyVerification?: ReturnType<typeof captureChannelMetadataToken>
  fullReadVerification?: ReturnType<typeof captureChannelMetadataToken>
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
      meta = await apiFetch<ChannelMetadata>(`/api/community/channels/${encodeURIComponent(channelId)}`, communityRequestOptions(queryClient, token, readSignal, assertActive))
      assertActive()
    } catch (error) {
      assertActive()
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        for (const id of token.registry!.runtime.ws.actions.revokeChannelAccess(serverId, channelId)) {
          const filters = { queryKey: ["community", "channel", id], predicate: (query: import("@tanstack/react-query").Query) => query !== resource }
          void queryClient.cancelQueries(filters)
          queryClient.removeQueries(filters)
          token.registry!.runtime.messageStream.actions.removeScope(serverId === null ? { kind: "dm", id } : { kind: "channel", id, serverId })
        }
        purgeCommunityChannel(token.registry!, channelId, true, resource)
      }
      throw error
    }
    if (meta.id !== channelId || meta.serverId !== serverId
      || !(serverId === null ? meta.type === "dm" : ["text", "forum", "thread"].includes(meta.type))
      || !(typeof meta.name === "string" || (serverId === null && meta.name === null))) throw new Error("Channel metadata scope mismatch")
    if (serverId !== null && !meta.archived) {
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
      return { id: metadata.id, serverId: metadata.serverId, verifiedEpoch: token.accessEpoch, verification: token, historyVerification: previous?.historyVerification,
        fullReadVerification: metadata.readContractVersion === 2 && metadata.accessDecision?.canRead ? token : undefined }
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: retryConversationRead,
    networkMode: "always",
  })
}
