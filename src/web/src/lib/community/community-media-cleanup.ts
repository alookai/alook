import { createLogger } from "@alook/shared"

const log = createLogger({ service: "community-media-cleanup" })

export const COMMUNITY_MEDIA_DELETE_BATCH_SIZE = 1000

export type CommunityMediaCleanupErrorCategory = "Error" | "TypeError" | "NonError"

export type CommunityMediaCleanupWarning = {
  event: string
  fields: Record<string, string | number>
}

export function communityMediaCleanupErrorCategory(
  error: unknown,
): CommunityMediaCleanupErrorCategory {
  if (error instanceof TypeError) return "TypeError"
  if (error instanceof Error) return "Error"
  return "NonError"
}

function normalizeCommunityMediaKeys(keys: string[]): string[] {
  return [...new Set(keys.filter((key) => key.length > 0))]
}

export async function deleteCommunityMediaObjects(
  bucket: Pick<R2Bucket, "delete">,
  keys: string[],
): Promise<void> {
  const normalized = normalizeCommunityMediaKeys(keys)
  for (let offset = 0; offset < normalized.length; offset += COMMUNITY_MEDIA_DELETE_BATCH_SIZE) {
    await bucket.delete(normalized.slice(offset, offset + COMMUNITY_MEDIA_DELETE_BATCH_SIZE))
  }
}

export function scheduleCommunityMediaCleanup(
  bucket: Pick<R2Bucket, "delete">,
  executionContext: Pick<ExecutionContext, "waitUntil">,
  input: { keys: string[]; warning: CommunityMediaCleanupWarning },
): void {
  const keys = normalizeCommunityMediaKeys(input.keys)
  if (keys.length === 0) return

  let warned = false
  const warnOnce = (error: unknown) => {
    if (warned) return
    warned = true
    log.warn(input.warning.event, {
      ...input.warning.fields,
      keyCount: keys.length,
      errorCategory: communityMediaCleanupErrorCategory(error),
    })
  }

  const cleanup = deleteCommunityMediaObjects(bucket, keys).catch(warnOnce)

  try {
    executionContext.waitUntil(cleanup)
  } catch (error) {
    warnOnce(error)
  }
}
