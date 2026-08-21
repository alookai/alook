import {
  isCommunityDeliveryDigest,
  isCommunityDeliveryOperationId,
  utf8ByteLength,
} from "@alook/shared"
import {
  COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES,
  COMMUNITY_DELIVERY_PROGRESS_LIMIT,
  type CompactCommunityDeliveryProgress,
  type UserConnectionState,
} from "./internal"
import type { CommunityDeliveryMode } from "../community-delivery-receipt"

export type CommunityDeliveryProgress = {
  operationId: string
  operationDigest: string
  mode: CommunityDeliveryMode
  nextFrameIndex: number
  frameCount: number
}

export type CommunityConnectionStatePreflight =
  | { ok: true; jsonByteLength: number }
  | { ok: false; reason: "invalid-progress" | "not-cloneable" | "json-budget"; jsonByteLength?: number }

function isSafeIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function decodeProgressEntry(value: unknown): CommunityDeliveryProgress | null {
  if (!Array.isArray(value) || value.length !== 5) return null
  const [operationId, operationDigest, mode, nextFrameIndex, frameCount] = value
  if (
    !isCommunityDeliveryOperationId(operationId)
    || !isCommunityDeliveryDigest(operationDigest)
    || (mode !== 0 && mode !== 1)
    || !isSafeIndex(nextFrameIndex)
    || !isSafeIndex(frameCount)
    || frameCount < 1
    || nextFrameIndex > frameCount
  ) return null
  return {
    operationId,
    operationDigest,
    mode: mode === 0 ? "batch" : "legacy",
    nextFrameIndex,
    frameCount,
  }
}

function encodeProgressEntry(value: CommunityDeliveryProgress): CompactCommunityDeliveryProgress {
  return [
    value.operationId,
    value.operationDigest,
    value.mode === "batch" ? 0 : 1,
    value.nextFrameIndex,
    value.frameCount,
  ]
}

export function readCommunityDeliveryProgress(
  state: UserConnectionState,
): { ok: true; entries: CommunityDeliveryProgress[] } | { ok: false } {
  if (state.communityDeliveryProgress === undefined) return { ok: true, entries: [] }
  if (
    !Array.isArray(state.communityDeliveryProgress)
    || state.communityDeliveryProgress.length > COMMUNITY_DELIVERY_PROGRESS_LIMIT
  ) return { ok: false }
  const entries: CommunityDeliveryProgress[] = []
  const operationIds = new Set<string>()
  for (const raw of state.communityDeliveryProgress) {
    const entry = decodeProgressEntry(raw)
    if (!entry || operationIds.has(entry.operationId)) return { ok: false }
    operationIds.add(entry.operationId)
    entries.push(entry)
  }
  return { ok: true, entries }
}

export function withCommunityDeliveryProgress(
  state: UserConnectionState,
  entry: CommunityDeliveryProgress,
): UserConnectionState {
  const decoded = readCommunityDeliveryProgress(state)
  if (!decoded.ok) throw new Error("invalid community delivery progress attachment")
  const next = decoded.entries.filter((candidate) => candidate.operationId !== entry.operationId)
  next.push(entry)
  const bounded = next.slice(-COMMUNITY_DELIVERY_PROGRESS_LIMIT).map(encodeProgressEntry)
  return { ...state, communityDeliveryProgress: bounded }
}

export function preflightCommunityConnectionState(
  state: UserConnectionState,
): CommunityConnectionStatePreflight {
  if (!readCommunityDeliveryProgress(state).ok) return { ok: false, reason: "invalid-progress" }
  try {
    structuredClone(state)
  } catch {
    return { ok: false, reason: "not-cloneable" }
  }
  const jsonByteLength = utf8ByteLength(JSON.stringify(state))
  if (jsonByteLength > COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES) {
    return { ok: false, reason: "json-budget", jsonByteLength }
  }
  return { ok: true, jsonByteLength }
}
