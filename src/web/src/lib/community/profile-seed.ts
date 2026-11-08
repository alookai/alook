import { createStore } from "@tanstack/store"
import type {
  CommunityProfilePatch,
} from "@/lib/community/models/people"
import type { MessageInput } from "@/lib/community/models/message"
import { canonicalCommunityUserImage, type CommunityResourceProfile, type FriendApprovalPayload } from "@alook/shared"
import {
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import { profileSchema, type ProfileRow } from "@/lib/community-db/schema"
import { readCommunityCollectionRow, writeCommunityCollectionChanges } from "@/lib/community-db/write"


type ProfileFieldRevisions = {
  identityAbout: number
  avatar: number
  status: number
  card: number
}

type ProfileRevisionState = {
  revision: number
  fieldsByUserId: Map<string, ProfileFieldRevisions>
  deletedByUserId: Map<string, number>
  pendingFieldsByUserId: Map<string, Partial<Omit<CommunityResourceProfile, "id">>>
  pendingOwner: string
}

export type CommunityProfileSeedSnapshot = {
  registry: CommunityDbRegistry | null
  revision: number
}

const createProfileRevisions = () => createStore<ProfileRevisionState>({ revision: 0, fieldsByUserId: new Map(), deletedByUserId: new Map(), pendingFieldsByUserId: new Map(), pendingOwner: "" })
const profileFactsSchema = profileSchema.partial()
const profileRevisionState = new WeakMap<CommunityDbRegistry, ReturnType<typeof createProfileRevisions>>()

function revisionState(registry: CommunityDbRegistry) {
  let state = profileRevisionState.get(registry)
  if (!state) {
    state = createProfileRevisions()
    profileRevisionState.set(registry, state)
  }
  return state
}

export function isCommunityProfileRetired(registry: CommunityDbRegistry, userId: string) {
  return revisionState(registry).get().deletedByUserId.has(userId)
}

export function retireCommunityProfile(userId: string, registry: CommunityDbRegistry, snapshot?: CommunityProfileSeedSnapshot) {
  if (!registry.runtime.lifecycle.get().active || snapshot && snapshot.registry !== registry) return
  const store = revisionState(registry), previous = store.get()
  const fields = previous.fieldsByUserId.get(userId)
  if (snapshot && fields && Object.values(fields).some(revision => revision > snapshot.revision)) return
  const revision = previous.revision + 1
  const deletedByUserId = new Map(previous.deletedByUserId), pendingFieldsByUserId = new Map(previous.pendingFieldsByUserId)
  const fieldsByUserId = new Map(previous.fieldsByUserId)
  fieldsByUserId.set(userId, { identityAbout: revision, avatar: revision, status: revision, card: revision })
  deletedByUserId.set(userId, revision)
  pendingFieldsByUserId.delete(userId)
  store.setState(() => ({ ...previous, revision, fieldsByUserId, deletedByUserId, pendingFieldsByUserId }))
  registry.runtime.ws.actions.forgetPresence(userId)
  return writeCommunityCollectionChanges(registry, "profiles", [], [userId])
}

export function beginCommunityProfileSeed(
  registry: CommunityDbRegistry | null,
): CommunityProfileSeedSnapshot {
  return { registry, revision: registry ? revisionState(registry).get().revision : 0 }
}

type CommunityUserProfileSeed = Partial<Omit<CommunityResourceProfile, "id">>

export function communityUserProfilePatch(
  userId: string,
  row: CommunityUserProfileSeed,
): CommunityProfilePatch {
  const statusText = row.statusText
  return {
    id: userId,
    identityAbout: {
      ...(row.name !== undefined ? { name: row.name } : {}),
      ...(row.discriminator === undefined ? {} : { discriminator: row.discriminator }),
      ...(row.aboutMe === undefined ? {} : { aboutMe: row.aboutMe }),
      ...(row.bannerColor === undefined ? {} : { bannerColor: row.bannerColor }),
      ...(row.kind === undefined ? {} : { kind: row.kind }),
      ...(row.ownerUserId === undefined ? {} : { ownerUserId: row.ownerUserId }),
    },
    ...(row.avatarVersion === undefined ? {} : { avatar: { avatarVersion: row.avatarVersion, ...(row.avatar === undefined ? {} : { avatar: row.avatar }) } }),
    ...(row.ownerHandle === undefined && row.mutualServers === undefined && row.ownedByViewer === undefined ? {} : { card: {
      ...(row.ownerHandle === undefined ? {} : { ownerHandle: row.ownerHandle }),
      ...(row.mutualServers === undefined ? {} : { mutualServers: row.mutualServers }),
      ...(row.ownedByViewer === undefined ? {} : { ownedByViewer: row.ownedByViewer }),
    } }),
    ...(row.statusEmoji === undefined && statusText === undefined
      ? {}
      : { status: {
          ...(row.statusEmoji !== undefined ? { statusEmoji: row.statusEmoji } : {}),
          ...(statusText !== undefined ? { statusText } : {}),
        } }),
  }
}

export function messageProfilePatches(messages: readonly Partial<Pick<MessageInput, "authorId" | "authorName" | "authorAvatar" | "authorAvatarVersion" | "replyTo" | "thread" | "approval">>[]): CommunityProfilePatch[] {
  const patches: CommunityProfilePatch[] = []
  for (const message of messages) {
    if (message.authorId) {
      patches.push({
        id: message.authorId,
        ...(message.authorName ? { identityAbout: { name: message.authorName } } : {}),
        ...(message.authorAvatarVersion !== undefined
          ? { avatar: {
              ...(message.authorAvatar === undefined ? {} : { avatar: message.authorAvatar }),
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
        ...(participant.name !== undefined ? { identityAbout: { name: participant.name } } : {}),
        ...(participant.avatarVersion === undefined ? {} : { avatar: {
          avatar: participant.avatar,
          avatarVersion: participant.avatarVersion,
        } }),
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
      avatar: canonicalCommunityUserImage(profile.id, profile.image, profile.avatarVersion),
      avatarVersion: profile.avatarVersion,
    },
  }] : [])
}

export function writeCommunityProfilePatches(
  patches: readonly CommunityProfilePatch[],
  registry: CommunityDbRegistry | null,
  options?: { snapshot?: CommunityProfileSeedSnapshot; event?: boolean; command?: boolean; resourceSeed?: boolean },
) {
  if (!registry || patches.length === 0 || !registry.runtime.lifecycle.get().active) return
  if (options?.snapshot && options.snapshot.registry !== registry) return
  const profiles = new Map<string, ProfileRow>()
  const revisionStore = revisionState(registry)
  const previous = revisionStore.get()
  const pendingOwner = JSON.stringify([registry.runtime.ws.get().profileAccountEpoch, registry.runtime.lifecycle.get().generation])
  const revisions = { ...previous, fieldsByUserId: new Map(previous.fieldsByUserId), deletedByUserId: new Map(previous.deletedByUserId), pendingFieldsByUserId: previous.pendingOwner === pendingOwner ? new Map(previous.pendingFieldsByUserId) : new Map<string, Partial<Omit<CommunityResourceProfile, "id">>>(), pendingOwner }
  const guardedRevision = options?.snapshot?.revision
  const writeRevision = options?.resourceSeed ? null : guardedRevision === undefined || options?.command ? revisions.revision + 1 : null
  let advanced = false
  for (const patch of patches) {
    const deletedAt = revisions.deletedByUserId.get(patch.id)
    if (deletedAt !== undefined && (options?.resourceSeed || guardedRevision !== undefined && guardedRevision < deletedAt)) continue
    const current = profiles.get(patch.id) ?? readCommunityCollectionRow(registry, "profiles", patch.id)
    const known = { ...current, ...revisions.pendingFieldsByUserId.get(patch.id) }
    const seedFields = <T extends object>(fields: T | undefined): T | undefined => {
      if (!fields || !options?.resourceSeed) return fields
      const selected = Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== undefined && known[key as keyof typeof known] === undefined)) as T
      return Object.keys(selected).length ? selected : undefined
    }
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
      ? seedFields(patch.identityAbout)
      : undefined
    const status = patch.status && accepts("status") ? seedFields(patch.status) : undefined
    const card = patch.card && accepts("card") ? seedFields(patch.card) : undefined
    const incomingAvatar = patch.avatar && accepts("avatar") && (
      known.avatarVersion === undefined
      || patch.avatar.avatarVersion > known.avatarVersion
      || (!options?.event && !options?.resourceSeed && patch.avatar.avatarVersion === known.avatarVersion)
    ) ? patch.avatar : undefined
    const fields = {
      ...known, id: patch.id,
      ...Object.fromEntries(Object.entries({ ...identityAbout, ...incomingAvatar, ...status, ...card }).filter(([, value]) => value !== undefined)),
      ...(registry.runtime.ws.get().presenceByUserId.has(patch.id) ? { presence: registry.runtime.ws.get().presenceByUserId.get(patch.id) } : {}),
    }
    const facts = profileFactsSchema.safeParse(Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== undefined && !key.startsWith("$"))))
    if (!facts.success) continue
    const parsed = profileSchema.safeParse(facts.data)
    if (parsed.success) {
      profiles.set(patch.id, parsed.data)
      revisions.deletedByUserId.delete(patch.id)
      revisions.pendingFieldsByUserId.delete(patch.id)
    } else if (!current && !options?.resourceSeed) {
      const { id: _id, ...pending } = facts.data
      revisions.pendingFieldsByUserId.set(patch.id, pending)
    }
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
  revisionStore.setState(() => revisions)
  const rows = [...profiles.values()]
  return writeCommunityCollectionChanges(registry, "profiles", rows)
}
