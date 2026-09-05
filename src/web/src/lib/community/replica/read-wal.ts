import { COMMUNITY_REPLICA_PROTOCOL_VERSION } from "@alook/shared"

const READ_WAL_PREFIX = `c-replica-v${COMMUNITY_REPLICA_PROTOCOL_VERSION}:read:`

export type CommunityReplicaReadIntent = {
  channelId: string
  messageId: string
  seq: number
  observedAt: string
}

function key(accountId: string, channelId: string) {
  return `${READ_WAL_PREFIX}${accountId}:${channelId}`
}

function parse(value: string | null): CommunityReplicaReadIntent | null {
  if (!value) return null
  try {
    const intent = JSON.parse(value) as Partial<CommunityReplicaReadIntent>
    if (
      typeof intent.channelId !== "string"
      || typeof intent.messageId !== "string"
      || !Number.isInteger(intent.seq)
      || (intent.seq ?? 0) <= 0
      || typeof intent.observedAt !== "string"
    ) return null
    return intent as CommunityReplicaReadIntent
  } catch {
    return null
  }
}

export function commitCommunityReplicaReadWal(
  accountId: string,
  intent: CommunityReplicaReadIntent,
) {
  if (typeof localStorage === "undefined") return intent
  const storageKey = key(accountId, intent.channelId)
  const current = parse(localStorage.getItem(storageKey))
  if (current && current.seq >= intent.seq) return current
  localStorage.setItem(storageKey, JSON.stringify(intent))
  return intent
}

export function listCommunityReplicaReadWal(accountId: string) {
  if (typeof localStorage === "undefined") return []
  const prefix = `${READ_WAL_PREFIX}${accountId}:`
  const intents: CommunityReplicaReadIntent[] = []
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const storageKey = localStorage.key(index)
    if (!storageKey?.startsWith(prefix)) continue
    const intent = parse(localStorage.getItem(storageKey))
    if (intent) intents.push(intent)
    else localStorage.removeItem(storageKey)
  }
  return intents
}

export function settleCommunityReplicaReadWal(
  accountId: string,
  channelId: string,
  confirmedSeq: number,
) {
  if (typeof localStorage === "undefined") return
  const storageKey = key(accountId, channelId)
  const current = parse(localStorage.getItem(storageKey))
  if (!current || current.seq <= confirmedSeq) localStorage.removeItem(storageKey)
}

export function discardCommunityReplicaReadWal(accountId: string, channelId: string) {
  if (typeof localStorage !== "undefined") localStorage.removeItem(key(accountId, channelId))
}

export function clearCommunityReplicaReadWal(accountId: string) {
  if (typeof localStorage === "undefined") return
  const prefix = `${READ_WAL_PREFIX}${accountId}:`
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const storageKey = localStorage.key(index)
    if (storageKey?.startsWith(prefix)) localStorage.removeItem(storageKey)
  }
}
