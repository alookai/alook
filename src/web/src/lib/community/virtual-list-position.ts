import { hashKey } from "@tanstack/react-query"
import type { VirtualItem } from "@tanstack/react-virtual"
import { isChannelMetadataTokenCurrent, type captureChannelMetadataToken } from "./conversation-qualification"

export type VirtualListPositionScope = {
  proof: ReturnType<typeof captureChannelMetadataToken>
  kind: "messages" | "forum"
  tag: string | null
}

export type VirtualListPositionSnapshot = {
  version: 1
  fingerprint: string
  offset: number
  width: number
  height: number
  paddingStart: number
  paddingEnd: number
  anchorKey: VirtualItem["key"]
  anchorOffset: number
  measurements: VirtualItem[]
  at: number
}

const POSITION_GC_MS = 5 * 60 * 1000
const MAX_POSITION_LISTS = 32
const MAX_POSITION_MEASUREMENTS = 2048

export function virtualListPositionKey({ proof, kind, tag }: VirtualListPositionScope) {
  const channelId = proof.channelId!
  const parentId = proof.channelLineage?.parentChannelId
  return ["community", "channel", channelId, "virtual-position", proof.viewerId, kind, tag,
    proof.accountEpoch, proof.accessEpoch, proof.ownerGeneration,
    proof.channelScopes.get(channelId)?.generation ?? 0,
    parentId ?? null, parentId ? proof.channelScopes.get(parentId)?.generation ?? 0 : 0] as const
}

export function virtualListLayoutFingerprint(rows: readonly unknown[]): string {
  const value = hashKey(rows)
  let first = 2166136261
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}

function current(scope: VirtualListPositionScope) {
  return !!scope.proof.viewerId && !!scope.proof.channelId && isChannelMetadataTokenCurrent(scope.proof)
}

export function readVirtualListPosition(scope: VirtualListPositionScope | undefined, fingerprint: string) {
  if (!scope || !current(scope)) return null
  const value = scope.proof.queryClient.getQueryData<VirtualListPositionSnapshot>(virtualListPositionKey(scope))
  return value?.version === 1 && value.fingerprint === fingerprint && Date.now() - value.at < POSITION_GC_MS ? value : null
}

export function saveVirtualListPosition(scope: VirtualListPositionScope | undefined, value: VirtualListPositionSnapshot) {
  if (!scope || !current(scope) || value.width <= 0 || value.height <= 0
    || !Number.isFinite(value.offset) || value.offset < 0 || !value.measurements.length) return
  const client = scope.proof.queryClient
  if (value.measurements.length > MAX_POSITION_MEASUREMENTS) {
    client.removeQueries({ queryKey: virtualListPositionKey(scope), exact: true })
    return
  }
  client.getQueryCache().build<VirtualListPositionSnapshot>(client, {
    queryKey: virtualListPositionKey(scope), gcTime: POSITION_GC_MS,
  }).setData(value)
  const records = client.getQueryCache().findAll({ predicate: query => query.queryKey[0] === "community"
    && query.queryKey[1] === "channel" && query.queryKey[3] === "virtual-position" })
    .sort((left, right) => left.state.dataUpdatedAt - right.state.dataUpdatedAt)
  for (const query of records.slice(0, Math.max(0, records.length - MAX_POSITION_LISTS))) client.getQueryCache().remove(query)
}
