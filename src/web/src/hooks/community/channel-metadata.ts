import { apiFetch } from "@/lib/api/client"
import { useCommunityWsStore } from "@/stores/community/ws"

export type ChannelMetadata = {
  id: string
  serverId: string
  name: string
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
  serverId: string,
  channelId: string,
  signal?: AbortSignal,
) {
  const token = captureChannelMetadataToken(channelId)
  const meta = await apiFetch<ChannelMetadata>(`/api/community/channels/${channelId}`, { signal })
  if (!isChannelMetadataTokenCurrent(token) || signal?.aborted) throw new DOMException("Stale channel metadata", "AbortError")
  if (meta.id !== channelId || meta.serverId !== serverId || !["text", "forum", "thread"].includes(meta.type)) throw new Error("Channel metadata scope mismatch")
  useCommunityWsStore.getState().grantServerAccess(serverId)
  useCommunityWsStore.getState().rememberChannelAccess(serverId, channelId, meta.parentChannelId)
  return { ...meta, archived: meta.archived === true || meta.archived === 1,
    activityAt: meta.lastMessageAt ?? meta.createdAt, verifiedEpoch: token.accessEpoch }
}
