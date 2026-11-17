import type { queries } from "@alook/shared"
import { deleteCommunityMediaObjects } from "@/lib/community/community-media-cleanup"

type Snapshot = queries.accountDeletion.AccountDeletionSnapshot
type DeletionBucket = Pick<R2Bucket, "delete" | "list">

export async function listAccountDeletionPrefix(
  bucket: Pick<R2Bucket, "list">,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    keys.push(...page.objects.map((object) => object.key))
    if (page.truncated) {
      if (!page.cursor) throw new Error("R2 prefix listing returned no cursor")
      cursor = page.cursor
    } else {
      cursor = undefined
    }
  } while (cursor)
  return keys
}

async function deleteBucketSnapshot(
  bucket: DeletionBucket,
  exactKeys: string[],
  prefixes: string[],
): Promise<void> {
  const listed: string[] = []
  for (const prefix of prefixes) {
    listed.push(...await listAccountDeletionPrefix(bucket, prefix))
  }
  await deleteCommunityMediaObjects(bucket, [...exactKeys, ...listed])
}

export async function deleteAccountStorage(
  env: Pick<Env, "COMMUNITY_MEDIA" | "BUG_REPORTS">,
  snapshot: Snapshot,
): Promise<void> {
  await deleteBucketSnapshot(
    env.COMMUNITY_MEDIA,
    snapshot.media.communityExactKeys,
    snapshot.media.communityPrefixes,
  )
  await deleteBucketSnapshot(
    env.BUG_REPORTS,
    snapshot.media.bugReportExactKeys,
    snapshot.media.bugReportPrefixes,
  )
}
