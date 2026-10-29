import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { beginCommunityProfileSeed } from "@/lib/community/profile-seed"

export function communityRegistrySnapshot(registry: CommunityDbRegistry) {
  return {
    collections: Object.fromEntries(Object.entries(registry.collections).map(([name, collection]) => [name, structuredClone([...collection.base.values()])])),
    profileRevision: beginCommunityProfileSeed(registry).revision,
  }
}
