import type {
  CommunityProfilePatch,
  CommunityUserCore,
} from "@/lib/community/models/people"
import type { Msg } from "@/lib/community/models/message"
import type { FriendApprovalPayload } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import { communityKeys } from "@/lib/query-keys"
import {
  getActiveCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { profileSchema, type ProfileRow } from "@/lib/community-db/schema"
import { useCommunityWsStore } from "@/stores/community/ws"

type ProfileFieldRevisions = {
  identityAbout: number
  avatar: number
  status: number
}

type ProfileRevisionState = {
  revision: number
  fieldsByUserId: Map<string, ProfileFieldRevisions>
}

export type CommunityProfileSeedSnapshot = {
  registry: CommunityDbRegistry | null
  revision: number
}

const profileRevisionState = new WeakMap<CommunityDbRegistry, ProfileRevisionState>()

function revisionState(registry: CommunityDbRegistry) {
  let state = profileRevisionState.get(registry)
  if (!state) {
    state = { revision: 0, fieldsByUserId: new Map() }
    profileRevisionState.set(registry, state)
  }
  return state
}

export function beginCommunityProfileSeed(
  registry = getActiveCommunityDbRegistry(),
): CommunityProfileSeedSnapshot {
  return { registry, revision: registry ? revisionState(registry).revision : 0 }
}

type CommunityUserProfileSeed = CommunityUserCore & {
  statusEmoji?: string | null
  statusText?: string | null
}

export function communityUserProfilePatch(
  userId: string,
  row: CommunityUserProfileSeed,
): CommunityProfilePatch {
  return {
    id: userId,
    identityAbout: {
      name: row.name,
      discriminator: row.discriminator,
    },
    avatar: { avatar: row.avatar, avatarVersion: row.avatarVersion },
    ...(row.statusEmoji === undefined && row.statusText === undefined
      ? {}
      : { status: {
          ...(row.statusEmoji !== undefined ? { statusEmoji: row.statusEmoji } : {}),
          ...(row.statusText !== undefined ? { statusText: row.statusText } : {}),
        } }),
  }
}

export function messageProfilePatches(messages: readonly Msg[]): CommunityProfilePatch[] {
  const patches: CommunityProfilePatch[] = []
  for (const message of messages) {
    if (message.authorId) {
      patches.push({
        id: message.authorId,
        ...(message.authorName ? { identityAbout: { name: message.authorName } } : {}),
        ...(message.authorAvatar !== undefined && message.authorAvatarVersion !== undefined
          ? { avatar: {
              avatar: message.authorAvatar,
              avatarVersion: message.authorAvatarVersion,
            } }
          : {}),
      })
    }
    if (message.replyTo?.authorId) {
      patches.push({
        id: message.replyTo.authorId,
        identityAbout: { name: message.replyTo.authorName },
      })
    }
    for (const participant of message.thread?.participants ?? []) {
      patches.push({
        id: participant.id,
        identityAbout: { name: participant.name },
        avatar: {
          avatar: participant.avatar,
          avatarVersion: participant.avatarVersion,
        },
      })
    }
    patches.push(...approvalProfilePatches(message.approval))
  }
  return patches
}

export function approvalProfilePatches(
  approval: FriendApprovalPayload | undefined,
): CommunityProfilePatch[] {
  if (!approval) return []
  return [
    approval.otherProfile,
    approval.botProfile,
    approval.waitingOnProfile,
  ].flatMap((profile) => profile ? [{
    id: profile.id,
    identityAbout: {
      name: profile.name,
      discriminator: profile.discriminator,
    },
    avatar: {
      avatar: profile.image ?? avatarInitial(profile.name),
      avatarVersion: profile.avatarVersion,
    },
  }] : [])
}

export function writeCommunityProfilePatches(
  patches: readonly CommunityProfilePatch[],
  registry = getActiveCommunityDbRegistry(),
  options?: { snapshot?: CommunityProfileSeedSnapshot; event?: boolean },
) {
  if (!registry || patches.length === 0) return
  if (options?.snapshot && options.snapshot.registry !== registry) return
  const queryKey = communityKeys.communityDbCollection(registry.scopeId, "profiles")
  const cached = registry.queryClient.getQueryData<ProfileRow[]>(queryKey)
    ?? Array.from(registry.collections.profiles.values())
  const profiles = new Map(cached.map((profile) => [profile.userId, profile]))
  const revisions = revisionState(registry)
  const guardedRevision = options?.snapshot?.revision
  const writeRevision = guardedRevision === undefined ? revisions.revision + 1 : null
  let advanced = false
  for (const patch of patches) {
    const current = profiles.get(patch.id)
    const fieldRevisions = revisions.fieldsByUserId.get(patch.id) ?? {
      identityAbout: 0,
      avatar: 0,
      status: 0,
    }
    const accepts = (field: keyof ProfileFieldRevisions) => (
      guardedRevision === undefined || fieldRevisions[field] <= guardedRevision
    )
    const identityAbout = patch.identityAbout && accepts("identityAbout")
      ? patch.identityAbout
      : undefined
    const status = patch.status && accepts("status") ? patch.status : undefined
    const incomingAvatar = patch.avatar && accepts("avatar") && (
      current === undefined
      || patch.avatar.avatarVersion > current.avatarVersion
      || (!options?.event && patch.avatar.avatarVersion === current.avatarVersion)
    ) ? patch.avatar : undefined
    const name = identityAbout?.name ?? current?.name ?? ""
    const next = profileSchema.parse({
      userId: patch.id,
      name,
      discriminator: identityAbout?.discriminator ?? current?.discriminator ?? "",
      avatar: incomingAvatar?.avatar ?? current?.avatar ?? avatarInitial(name),
      avatarVersion: incomingAvatar?.avatarVersion ?? current?.avatarVersion ?? 0,
      aboutMe: identityAbout?.aboutMe ?? current?.aboutMe,
      bannerColor: identityAbout?.bannerColor === undefined
        ? current?.bannerColor
        : identityAbout.bannerColor,
      kind: identityAbout?.kind ?? current?.kind,
      ownerUserId: identityAbout?.ownerUserId === undefined
        ? current?.ownerUserId
        : identityAbout.ownerUserId,
      statusEmoji: status?.statusEmoji === undefined
        ? current?.statusEmoji
        : status.statusEmoji,
      statusText: status?.statusText === undefined
        ? current?.statusText
        : status.statusText,
    })
    profiles.set(patch.id, next)
    if (writeRevision !== null) {
      const nextRevisions = { ...fieldRevisions }
      if (identityAbout) nextRevisions.identityAbout = writeRevision
      if (incomingAvatar) nextRevisions.avatar = writeRevision
      if (status) nextRevisions.status = writeRevision
      if (identityAbout || incomingAvatar || status) {
        revisions.fieldsByUserId.set(patch.id, nextRevisions)
        advanced = true
      }
    }
  }
  if (advanced && writeRevision !== null) revisions.revision = writeRevision
  const rows = [...profiles.values()]
  if (registry.collections.profiles.status === "ready") {
    registry.collections.profiles.utils.writeUpsert(rows)
  }
  registry.queryClient.setQueryData(queryKey, rows)
}

export async function loadAndSeedProfiles<T>(
  load: () => Promise<T>,
  patches: (data: T) => readonly CommunityProfilePatch[],
): Promise<T> {
  const overlay = useCommunityWsStore.getState()
  const overlaySnapshot = overlay.beginPresenceSnapshot()
  const profileSnapshot = beginCommunityProfileSeed()
  const data = await load()
  const projected = patches(data)
  writeCommunityProfilePatches(projected, profileSnapshot.registry, {
    snapshot: profileSnapshot,
  })
  const presence = projected.flatMap((patch) => (
    patch.presence === undefined
      ? []
      : [{ id: patch.id, presence: patch.presence }]
  ))
  if (presence.length > 0) {
    overlay.seedPresence(
      overlaySnapshot,
      presence.map((patch) => [patch.id, patch.presence] as const),
    )
  }
  return data
}

export function apiFetchProfiles<T>(
  path: string,
  patches: (data: T) => readonly CommunityProfilePatch[],
  options?: RequestInit,
): Promise<T> {
  return loadAndSeedProfiles(
    () => options ? apiFetch<T>(path, options) : apiFetch<T>(path),
    patches,
  )
}
