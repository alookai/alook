import { loadCommunityRequest } from "@/lib/community/account-cache-lifecycle"
import { createStore } from "@tanstack/react-store"
import type {
  CommunityProfilePatch,
  CommunityUserCore,
} from "@/lib/community/models/people"
import type { Msg } from "@/lib/community/models/message"
import type { FriendApprovalPayload } from "@alook/shared"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import { communityKeys } from "@/lib/query-keys"
import {
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { profileSchema, type ProfileRow } from "@/lib/community-db/schema"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { currentSource, withSource } from "@/lib/observability/data-source"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

type ProfileFieldRevisions = {
  identityAbout: number
  avatar: number
  status: number
  card: number
}

type ProfileRevisionState = {
  revision: number
  fieldsByUserId: Map<string, ProfileFieldRevisions>
}

export type CommunityProfileSeedSnapshot = {
  registry: CommunityDbRegistry | null
  revision: number
}

const createProfileRevisions = () => createStore<ProfileRevisionState>({ revision: 0, fieldsByUserId: new Map() })
const profileRevisionState = new WeakMap<CommunityDbRegistry, ReturnType<typeof createProfileRevisions>>()

function revisionState(registry: CommunityDbRegistry) {
  let state = profileRevisionState.get(registry)
  if (!state) {
    state = createProfileRevisions()
    profileRevisionState.set(registry, state)
  }
  return state
}

export function beginCommunityProfileSeed(
  registry: CommunityDbRegistry | null,
): CommunityProfileSeedSnapshot {
  return { registry, revision: registry ? revisionState(registry).get().revision : 0 }
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

export function messageProfilePatches(messages: readonly Partial<Pick<Msg, "authorId" | "authorName" | "authorAvatar" | "authorAvatarVersion" | "replyTo" | "thread" | "approval">>[]): CommunityProfilePatch[] {
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
  registry: CommunityDbRegistry | null,
  options?: { snapshot?: CommunityProfileSeedSnapshot; event?: boolean; command?: boolean },
) {
  if (!registry || patches.length === 0) return
  if (options?.snapshot && options.snapshot.registry !== registry) return
  const queryKey = communityKeys.communityDbCollection(registry.scopeId, "profiles")
  const cached = registry.queryClient.getQueryData<ProfileRow[]>(queryKey)
    ?? Array.from(registry.collections.profiles.values())
  const profiles = new Map(cached.map((profile) => [profile.userId, profile]))
  const revisionStore = revisionState(registry)
  const previous = revisionStore.get()
  const revisions = { ...previous, fieldsByUserId: new Map(previous.fieldsByUserId) }
  const guardedRevision = options?.snapshot?.revision
  const writeRevision = guardedRevision === undefined || options?.command ? revisions.revision + 1 : null
  let advanced = false
  for (const patch of patches) {
    const current = profiles.get(patch.id)
    const fieldRevisions = revisions.fieldsByUserId.get(patch.id) ?? {
      identityAbout: 0,
      avatar: 0,
      status: 0,
      card: 0,
    }
    const accepts = (field: keyof ProfileFieldRevisions) => (
      guardedRevision === undefined || fieldRevisions[field] <= guardedRevision
    )
    const identityAbout = patch.identityAbout && accepts("identityAbout")
      ? patch.identityAbout
      : undefined
    const status = patch.status && accepts("status") ? patch.status : undefined
    const card = patch.card && accepts("card") ? patch.card : undefined
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
      ownerHandle: card?.ownerHandle === undefined ? current?.ownerHandle : card.ownerHandle,
      mutualServers: card?.mutualServers ?? current?.mutualServers,
      ownedByViewer: card?.ownedByViewer ?? current?.ownedByViewer,
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
      if (card) nextRevisions.card = writeRevision
      if (identityAbout || incomingAvatar || status || card) {
        revisions.fieldsByUserId.set(patch.id, nextRevisions)
        advanced = true
      }
    }
  }
  if (advanced && writeRevision !== null) revisions.revision = writeRevision
  if (advanced) revisionStore.setState(() => revisions)
  const rows = [...profiles.values()]
  withSource(registry.queryClient, currentSource(registry.queryClient) === "ws" ? "ws" : options?.snapshot ? "network" : options?.command ? "local_mutation" : "unknown", () => writeCommunityCollectionRows(registry, "profiles", rows, (row) => row.userId))
}

export async function loadAndSeedProfiles<T>(
  load: (options: ApiRequestOptions) => Promise<T>,
  patches: (data: T) => readonly CommunityProfilePatch[],
  registry: CommunityDbRegistry | null,
  signal?: AbortSignal,
  requestToken?: ReturnType<typeof captureCommunityLiveSnapshotToken>,
): Promise<T> {
  if (!registry) throw new DOMException("Missing community profile owner", "AbortError")
  const token = requestToken ?? captureCommunityLiveSnapshotToken(registry.queryClient)
  const overlay = registry.runtime.ws.actions
  const overlaySnapshot = overlay.beginPresenceSnapshot()
  const profileSnapshot = token.profileSnapshot
  if (token.registry !== registry) throw new DOMException("Mismatched community profile owner", "AbortError")
  const data = await loadCommunityRequest(load, token, signal)
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
  options: ApiRequestOptions | undefined,
  registry: CommunityDbRegistry | null,
  requestToken?: ReturnType<typeof captureCommunityLiveSnapshotToken>,
): Promise<T> {
  return loadAndSeedProfiles(
    (origin) => apiFetch<T>(path, {
      ...options,
      ...origin,
      signal: options?.signal,
      assertActive: () => { origin.assertActive?.(); options?.assertActive?.() },
    }),
    patches,
    registry,
    options?.signal ?? undefined,
    requestToken,
  )
}
