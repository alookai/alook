import { apiFetch } from "@/lib/api/client"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { QueryClient } from "@tanstack/react-query"
import { queryOptions } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { ApiError } from "@/lib/errors"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
  publishCommunityChannelMetadata,
} from "@/lib/community-db/sync"

export type ChannelMetadata = {
  historyVerification?: ReturnType<typeof captureChannelMetadataToken>
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

export function captureChannelMetadataToken(channelId: string) {
  const state = useCommunityWsStore.getState()
  return {
    viewerId: state.profileViewerId,
    accountEpoch: state.profileAccountEpoch,
    accessEpoch: state.accessEpoch,
    channelId,
    generation: state.channelAccessScopes.get(channelId)?.generation ?? 0,
  }
}

export function isChannelMetadataTokenCurrent(token: ReturnType<typeof captureChannelMetadataToken>) {
  const state = useCommunityWsStore.getState()
  return state.profileViewerId === token.viewerId
    && state.profileAccountEpoch === token.accountEpoch
    && state.accessEpoch === token.accessEpoch
    && (state.channelAccessScopes.get(token.channelId)?.generation ?? 0) === token.generation
}

export async function fetchChannelMetadata(
  serverId: string | null,
  channelId: string,
  signal?: AbortSignal,
  validatePublication?: () => void,
) {
  const token = captureChannelMetadataToken(channelId)
  const meta = await apiFetch<ChannelMetadata>(`/api/community/channels/${encodeURIComponent(channelId)}`, { signal })
  if (!isChannelMetadataTokenCurrent(token) || signal?.aborted) throw new DOMException("Stale channel metadata", "AbortError")
  validatePublication?.()
  if (meta.id !== channelId || meta.serverId !== serverId
    || !(serverId === null ? meta.type === "dm" : ["text", "forum", "thread"].includes(meta.type))
    || !(typeof meta.name === "string" || (serverId === null && meta.name === null))) {
    throw new Error("Channel metadata scope mismatch")
  }
  if (serverId !== null) {
    useCommunityWsStore.getState().grantServerAccess(serverId)
    useCommunityWsStore.getState().rememberChannelAccess(serverId, channelId, meta.parentChannelId)
  }
  return { ...meta, name: meta.name ?? "", archived: meta.archived === true || meta.archived === 1,
    activityAt: meta.lastMessageAt ?? meta.createdAt, verifiedEpoch: token.accessEpoch, verification: token }
}

async function fetchAndPublishChannelMetadata(
  queryClient: QueryClient,
  serverId: string | null,
  channelId: string,
  signal?: AbortSignal,
) {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const validate = () => assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
  try {
    const metadata = await fetchChannelMetadata(serverId, channelId, signal, validate)
    publishCommunityChannelMetadata(queryClient, { metadata, proof: { token, signal } })
    return metadata
  } catch (error) {
    validate()
    throw error
  }
}

export function channelMetadataOptions(queryClient: QueryClient, serverId: string | null, channelId: string) {
  return queryOptions({
    queryKey: communityKeys.channelMeta(serverId, channelId),
    queryFn: async ({ signal }) => {
      const metadata = await fetchAndPublishChannelMetadata(queryClient, serverId, channelId, signal)
      const previous = queryClient.getQueryData<ChannelMetadata>(communityKeys.channelMeta(serverId, channelId))
      return { ...metadata, historyVerification: previous?.historyVerification }
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && [401, 403, 404].includes(error.status)) && failureCount < 1,
  })
}
