import { queries, type Database } from "@alook/shared"

export function readCommunityResourceProfiles(db: Database, userIds: readonly string[]) {
  return queries.communityUserProfile.getResourceProfiles(db, userIds)
}
