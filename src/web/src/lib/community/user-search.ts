import { CommunityUserSearchReadSchema, type CommunityUserSearchRead } from "@alook/shared"
import type { QueryClient } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { CommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { apiFetchProfiles } from "./account-cache-lifecycle"

export async function searchCommunityUserIds(query: string, client: QueryClient, options?: ApiRequestOptions, token?: CommunityLiveSnapshotToken): Promise<string[]> {
  const data = await apiFetchProfiles<CommunityUserSearchRead>(`/api/community/users/search?q=${encodeURIComponent(query)}`,
    (response) => CommunityUserSearchReadSchema.parse(response).users.map((user) => ({
      id: user.id, identityAbout: { name: user.name, discriminator: user.discriminator },
      avatar: { avatar: user.image, avatarVersion: user.avatarVersion },
    })), options, getCommunityDbRegistry(client), token)
  return data.users.map((user) => user.id)
}
