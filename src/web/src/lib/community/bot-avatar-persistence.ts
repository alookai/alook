import { createLogger, queries, type Database } from "@alook/shared"
import { communityMediaCleanupErrorCategory } from "./community-media-cleanup"
import { cleanupAvatarCandidate } from "./avatar-media-reconciliation"
import { botAvatarUrl } from "./storage"

const log = createLogger({ service: "community-bot-avatar" })

export type BotAvatarPersistenceOutcome =
  | {
      kind: "persisted"
      avatarVersion: number
      avatarObjectKey: string
      previousObjectKey: string | null
    }
  | { kind: "not_found" }
  | { kind: "failed" }

async function compensateCandidate(
  db: Database,
  bucket: Pick<R2Bucket, "delete">,
  botId: string,
  objectKey: string,
  phase: "zero_row" | "unknown_noncurrent",
): Promise<void> {
  try {
    const outcome = await cleanupAvatarCandidate(
      db,
      bucket,
      { kind: "bot", id: botId },
      objectKey,
    )
    if (outcome === "retained_unverified") {
      log.warn("community_bot_avatar_cleanup_unverified", {
        phase,
        objectState: outcome,
      })
    }
  } catch (error) {
    log.warn("community_bot_avatar_cleanup_failed", {
      phase,
      errorCategory: communityMediaCleanupErrorCategory(error),
    })
  }
}

export async function persistUploadedBotAvatar(
  db: Database,
  bucket: Pick<R2Bucket, "delete">,
  input: { botId: string; ownerId: string; objectKey: string },
): Promise<BotAvatarPersistenceOutcome> {
  try {
    const published = await queries.communityBot.publishOwnedBotAvatar(
      db,
      input.botId,
      input.ownerId,
      { objectKey: input.objectKey, stableUrl: botAvatarUrl(input.botId) },
    )
    if (published) {
      return {
        kind: "persisted",
        avatarVersion: published.current.avatarVersion,
        avatarObjectKey: input.objectKey,
        previousObjectKey: published.previous.avatarObjectKey,
      }
    }
  } catch (error) {
    try {
      const current = await queries.communityBot.getLiveBotAvatar(db, input.botId)
      if (current?.avatarObjectKey === input.objectKey && current.avatarVersion > 0) {
        return {
          kind: "persisted",
          avatarVersion: current.avatarVersion,
          avatarObjectKey: input.objectKey,
          previousObjectKey: null,
        }
      }
      await compensateCandidate(db, bucket, input.botId, input.objectKey, "unknown_noncurrent")
    } catch (verificationError) {
      log.warn("community_bot_avatar_persist_verification_failed", {
        phase: "unknown_commit",
        objectState: "retained_unverified",
        persistErrorCategory: communityMediaCleanupErrorCategory(error),
        verificationErrorCategory: communityMediaCleanupErrorCategory(verificationError),
      })
    }
    return { kind: "failed" }
  }

  await compensateCandidate(db, bucket, input.botId, input.objectKey, "zero_row")
  return { kind: "not_found" }
}
