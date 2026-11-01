import { queries, type Database, type CommunityResourceProfile } from "@alook/shared"

export type CommunityResourceProfileReader = (userIds: readonly string[]) => Promise<CommunityResourceProfile[]>

export function readCommunityResourceProfiles(db: Database, userIds: readonly string[]) {
  return queries.communityUserProfile.getResourceProfiles(db, userIds)
}

export function createCommunityResourceProfileReader(db: Database): CommunityResourceProfileReader {
  const pending = new Map<string, Promise<CommunityResourceProfile | undefined>>()
  return async userIds => {
    const ids = [...new Set(userIds)], missing = ids.filter(id => !pending.has(id))
    if (missing.length) {
      const batch = readCommunityResourceProfiles(db, missing).then(profiles => new Map(profiles.map(profile => [profile.id, profile])))
      for (const id of missing) {
        const value = batch.then(profiles => profiles.get(id))
        pending.set(id, value)
        void value.catch(() => { if (pending.get(id) === value) pending.delete(id) })
      }
    }
    const profiles = await Promise.all(ids.map(id => pending.get(id)!))
    return profiles.filter(profile => profile !== undefined)
  }
}
