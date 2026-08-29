import type {
  CommunityProfilePatch,
  CommunityProfileSnapshot,
  CommunityUserCore,
} from "@/lib/community/models/people"
import type { InfiniteData, QueryClient } from "@tanstack/react-query"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import type { FriendApprovalPayload } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { avatarInitial } from "@/lib/community/avatar"
import { shouldPersistQueryKey } from "@/lib/query-persister"
import { useCommunityWsStore } from "@/stores/community/ws"

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

export function seedPersistedMessageProfiles(
  queryClient: QueryClient,
  snapshot: CommunityProfileSnapshot,
) {
  const patches: CommunityProfilePatch[] = []
  const cached = queryClient.getQueriesData<InfiniteData<MessagesPage>>({
    predicate: (query) => shouldPersistQueryKey(query.queryKey),
  })
  for (const [, data] of cached) {
    for (const page of data?.pages ?? []) {
      patches.push(...messageProfilePatches(page.messages))
    }
  }
  useCommunityWsStore.getState().seedProfiles(snapshot, patches)
}

export async function loadAndSeedProfiles<T>(
  load: () => Promise<T>,
  patches: (data: T) => readonly CommunityProfilePatch[],
): Promise<T> {
  const profiles = useCommunityWsStore.getState()
  const snapshot = profiles.beginProfileSnapshot()
  const data = await load()
  profiles.seedProfiles(snapshot, patches(data))
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
