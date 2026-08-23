import { createLogger, queries, type Database } from "@alook/shared"
import {
  communityMediaCleanupErrorCategory,
  deleteCommunityMediaObjects,
} from "./community-media-cleanup"
import { buildBotAvatarKey, botAvatarUrl } from "./storage"

const log = createLogger({ service: "community-bot-avatar" })

export type BotAvatarPersistenceOutcome =
  | { kind: "persisted" }
  | { kind: "not_found" }
  | { kind: "failed" }

async function compensateBotAvatar(
  bucket: Pick<R2Bucket, "delete">,
  botId: string,
  phase: "zero_row_delete_winner" | "d1_error_tombstoned",
): Promise<void> {
  try {
    await deleteCommunityMediaObjects(bucket, [buildBotAvatarKey(botId)])
  } catch (error) {
    log.warn("community_bot_avatar_cleanup_failed", {
      botId,
      phase,
      keyCount: 1,
      errorCategory: communityMediaCleanupErrorCategory(error),
    })
  }
}

/**
 * Persist a fixed-key bot-avatar upload after R2 PUT.
 *
 * The owner-scoped live UPDATE is the linearization point. A zero-row result
 * can only mean the bot lost to delete after the caller's live-owner preflight,
 * so inline deletion is safe. A thrown write has unknown commit state: verify
 * the live row and delete only when the bot is definitely gone. R2 fixed-key
 * deletion has no CAS, so every live verification result must retain the
 * object to avoid deleting a later concurrent upload.
 */
export async function persistUploadedBotAvatar(
  db: Database,
  bucket: Pick<R2Bucket, "delete">,
  input: { botId: string; ownerId: string },
): Promise<BotAvatarPersistenceOutcome> {
  const url = botAvatarUrl(input.botId)

  try {
    const updated = await queries.communityBot.updateBot(
      db,
      input.botId,
      input.ownerId,
      { image: url },
    )
    if (updated) return { kind: "persisted" }
  } catch (error) {
    let live: { id: string; image: string | null } | null
    try {
      live = await queries.communityBot.getLiveBotAvatar(db, input.botId)
    } catch (verificationError) {
      log.warn("community_bot_avatar_persist_verification_failed", {
        botId: input.botId,
        phase: "d1_error_verification",
        objectState: "retained_unverified",
        persistErrorCategory: communityMediaCleanupErrorCategory(error),
        verificationErrorCategory: communityMediaCleanupErrorCategory(verificationError),
      })
      return { kind: "failed" }
    }

    if (!live) {
      await compensateBotAvatar(bucket, input.botId, "d1_error_tombstoned")
      log.warn("community_bot_avatar_persist_failed", {
        botId: input.botId,
        phase: "d1_error_live_verification",
        objectState: "compensated_tombstoned",
        errorCategory: communityMediaCleanupErrorCategory(error),
      })
      return { kind: "failed" }
    }

    log.warn("community_bot_avatar_persist_failed", {
      botId: input.botId,
      phase: "d1_error_live_verification",
      objectState:
        live.image === url
          ? "retained_live_canonical"
          : "retained_live_noncanonical",
      errorCategory: communityMediaCleanupErrorCategory(error),
    })
    return { kind: "failed" }
  }

  await compensateBotAvatar(bucket, input.botId, "zero_row_delete_winner")
  return { kind: "not_found" }
}
