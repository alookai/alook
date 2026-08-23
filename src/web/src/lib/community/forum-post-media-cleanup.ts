import {
  COMMUNITY_MEDIA_DELETE_BATCH_SIZE,
  scheduleCommunityMediaCleanup,
} from "./community-media-cleanup"

export { COMMUNITY_MEDIA_DELETE_BATCH_SIZE }

export type ForumPostMediaCleanup = {
  openerId: string
  childChannelId: string
  keys: string[]
}

/**
 * Schedule best-effort R2 cleanup after the authoritative D1 batch commits.
 * R2 multi-delete is idempotent for missing objects, so duplicate delivery is
 * harmless. The complete chunk chain is registered with the real Worker
 * ExecutionContext; callers must not await it before returning the HTTP 204.
 */
export function scheduleForumPostMediaCleanup(
  bucket: Pick<R2Bucket, "delete">,
  executionContext: Pick<ExecutionContext, "waitUntil">,
  input: ForumPostMediaCleanup,
): void {
  scheduleCommunityMediaCleanup(bucket, executionContext, {
    keys: input.keys,
    warning: {
      event: "forum_post_media_cleanup_failed",
      fields: {
        openerId: input.openerId,
        childChannelId: input.childChannelId,
      },
    },
  })
}
