"use client"

import type { ChannelMetadata } from "./channel-metadata"
import { useChannelMetadata } from "./use-channel-metadata"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"

function projectChildMeta(payload: ChannelMetadata, verifiedEpoch: number): ChildChannelMeta {
  if (!payload.serverId || !payload.parentChannelId || !payload.parentMessageId) {
    throw new Error("invalid child channel metadata")
  }
  return {
    id: payload.id,
    serverId: payload.serverId,
    name: payload.name ?? "",
    type: payload.type,
    parentChannelId: payload.parentChannelId,
    parentMessageId: payload.parentMessageId,
    creatorId: payload.creatorId,
    archived: payload.archived === true || payload.archived === 1,
    activityAt: payload.lastMessageAt ?? payload.createdAt,
    verifiedEpoch,
  }
}

export function sameChildChannelMeta(left: ChildChannelMeta, right: ChildChannelMeta): boolean {
  return left.id === right.id &&
    left.serverId === right.serverId &&
    left.name === right.name &&
    left.type === right.type &&
    left.parentChannelId === right.parentChannelId &&
    left.parentMessageId === right.parentMessageId &&
    (left.creatorId ?? null) === (right.creatorId ?? null) &&
    left.archived === right.archived &&
    left.activityAt === right.activityAt &&
    left.verifiedEpoch === right.verifiedEpoch
}

type TrustedChildMeta = { channelId: string; meta: ChildChannelMeta } | null

export function updateTrustedChildMeta(
  current: TrustedChildMeta,
  channelId: string,
  data: ChildChannelMeta,
): TrustedChildMeta {
  if (data.archived) return current === null ? current : null
  if (
    current?.channelId === channelId
    && sameChildChannelMeta(current.meta, data)
  ) return current
  return { channelId, meta: data }
}

export function pickRenderableChildMeta(
  meta: ChildChannelMeta | undefined,
  trusted: ChildChannelMeta | undefined,
  accessEpoch: number,
): ChildChannelMeta | undefined {
  if (meta?.verifiedEpoch === accessEpoch) return meta.archived ? undefined : meta
  if (trusted?.id === meta?.id || !meta) return trusted?.archived ? undefined : trusted
  return undefined
}

export function useChildChannelMeta(serverId: string, channelId: string, enabled: boolean, _placeholderData?: ChildChannelMeta) {
  const query = useChannelMetadata(serverId, enabled ? channelId : undefined)
  const data = query.data?.type === "thread" && query.data.parentChannelId && query.data.parentMessageId && !query.data.archived
    ? projectChildMeta(query.data, query.data.verifiedEpoch) : undefined
  return { ...query, data, isVerified: query.isVerified && !!data }
}
