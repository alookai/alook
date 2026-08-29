"use client"

import { apiFetch } from "@/lib/api/client"
import { useCommunityWsStore } from "@/stores/community/ws"

type IdentitySlot = Readonly<{
  userId: string
  avatar: string
  avatarVersion: string
}>

const EXPLICIT_IDENTITY_SLOTS: readonly IdentitySlot[] = [
  { userId: "authorId", avatar: "authorAvatar", avatarVersion: "authorAvatarVersion" },
  { userId: "otherUserId", avatar: "otherUserAvatar", avatarVersion: "otherUserAvatarVersion" },
  { userId: "creatorId", avatar: "creatorAvatar", avatarVersion: "creatorAvatarVersion" },
]

type IdentityObservation = Readonly<{
  slot: IdentitySlot
  userId: string
  avatar: string
  avatarVersion: number
}>

type IdentityConflictHandler = (userId: string) => void

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function observationsFor(record: Record<string, unknown>): IdentityObservation[] {
  const slots = [...EXPLICIT_IDENTITY_SLOTS]
  if (typeof record.userId === "string") {
    slots.push({ userId: "userId", avatar: "avatar", avatarVersion: "avatarVersion" })
    slots.push({ userId: "userId", avatar: "image", avatarVersion: "avatarVersion" })
  } else {
    slots.push({ userId: "id", avatar: "avatar", avatarVersion: "avatarVersion" })
    slots.push({ userId: "id", avatar: "image", avatarVersion: "avatarVersion" })
  }

  return slots.flatMap((slot) => {
    const userId = record[slot.userId]
    const avatar = record[slot.avatar]
    const avatarVersion = record[slot.avatarVersion]
    return typeof userId === "string"
      && typeof avatar === "string"
      && typeof avatarVersion === "number"
      && Number.isSafeInteger(avatarVersion)
      && avatarVersion >= 0
      ? [{ slot, userId, avatar, avatarVersion }]
      : []
  })
}

function visitIdentityPayload(
  value: unknown,
  visit: (record: Record<string, unknown>, observations: IdentityObservation[]) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visitIdentityPayload(item, visit)
    return
  }
  const record = objectValue(value)
  if (!record) return
  const observations = observationsFor(record)
  if (observations.length > 0) visit(record, observations)
  for (const child of Object.values(record)) visitIdentityPayload(child, visit)
}

function projectValue(value: unknown, onConflict?: IdentityConflictHandler): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const projected = value.map((item) => {
      const next = projectValue(item, onConflict)
      changed ||= next !== item
      return next
    })
    return changed ? projected : value
  }

  const record = objectValue(value)
  if (!record) return value
  let next: Record<string, unknown> | undefined
  const write = (key: string, fieldValue: unknown) => {
    next ??= { ...record }
    next[key] = fieldValue
  }

  for (const [key, child] of Object.entries(record)) {
    const projected = projectValue(child, onConflict)
    if (projected !== child) write(key, projected)
  }

  const identities = useCommunityWsStore.getState().avatarIdentities
  for (const observation of observationsFor(record)) {
    const current = identities.get(observation.userId)
    if (!current) continue
    if (current.avatarVersion === observation.avatarVersion) {
      if (current.avatar !== observation.avatar) onConflict?.(observation.userId)
      if (current.avatar === observation.avatar) continue
    }
    if (current.avatarVersion < observation.avatarVersion) continue
    write(observation.slot.avatar, current.avatar)
    write(observation.slot.avatarVersion, current.avatarVersion)
  }
  return next ?? value
}

/**
 * Register every identity carried by an authoritative HTTP payload, then
 * overlay the account-bound highest version over older nested projections.
 * The two-pass order prevents an old row earlier in the response from
 * overwriting a newer row later in the same response.
 */
export function projectIdentityPayload<T>(
  value: T,
  onConflict?: IdentityConflictHandler,
): T {
  const store = useCommunityWsStore.getState()
  visitIdentityPayload(value, (_record, observations) => {
    for (const observation of observations) {
      const result = store.observeAvatarIdentity(
        observation.userId,
        observation.avatar,
        observation.avatarVersion,
      )
      if (result === "conflict") onConflict?.(observation.userId)
    }
  })
  return projectValue(value, onConflict) as T
}

export async function apiFetchIdentity<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  return projectIdentityPayload(
    options === undefined
      ? await apiFetch<T>(path)
      : await apiFetch<T>(path, options),
  )
}
