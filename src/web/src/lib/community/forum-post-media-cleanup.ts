import { createLogger } from "@alook/shared";

const log = createLogger({ service: "community-forum-post-delete" });
export const COMMUNITY_MEDIA_DELETE_BATCH_SIZE = 1000;

export type ForumPostMediaCleanup = {
  openerId: string;
  childChannelId: string;
  keys: string[];
};

function cleanupErrorCategory(err: unknown): "Error" | "TypeError" | "NonError" {
  if (err instanceof TypeError) return "TypeError";
  if (err instanceof Error) return "Error";
  return "NonError";
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
  const keys = [...new Set(input.keys.filter((key) => key.length > 0))];
  if (keys.length === 0) return;

  const cleanup = (async () => {
    for (let offset = 0; offset < keys.length; offset += COMMUNITY_MEDIA_DELETE_BATCH_SIZE) {
      await bucket.delete(keys.slice(offset, offset + COMMUNITY_MEDIA_DELETE_BATCH_SIZE));
    }
  })().catch((err) => {
    log.warn("forum_post_media_cleanup_failed", {
      openerId: input.openerId,
      childChannelId: input.childChannelId,
      keyCount: keys.length,
      errorCategory: cleanupErrorCategory(err),
    });
  });

  executionContext.waitUntil(cleanup);
}
