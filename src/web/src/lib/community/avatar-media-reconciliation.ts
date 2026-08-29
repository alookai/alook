import { getCloudflareContext } from "@opennextjs/cloudflare"
import { createLogger, queries, type Database } from "@alook/shared"
import {
  communityMediaCleanupErrorCategory,
} from "./community-media-cleanup"
import {
  buildBotAvatarKey,
  buildUserAvatarKey,
  isOwnedBotAvatarObjectKey,
  isOwnedUserAvatarObjectKey,
} from "./storage"

const log = createLogger({ service: "community-avatar-media" })
const MAX_ALIAS_RECONCILIATION_ATTEMPTS = 3

export type AvatarSubject = { kind: "human" | "bot"; id: string }

type AvatarState = {
  avatarVersion: number
  avatarObjectKey: string | null
}

type AvatarBucket = Pick<R2Bucket, "delete" | "get" | "head" | "put">

function aliasKey(subject: AvatarSubject): string {
  return subject.kind === "human"
    ? buildUserAvatarKey(subject.id)
    : buildBotAvatarKey(subject.id)
}

function ownsChild(subject: AvatarSubject, key: string): boolean {
  return subject.kind === "human"
    ? isOwnedUserAvatarObjectKey(key, subject.id)
    : isOwnedBotAvatarObjectKey(key, subject.id)
}

async function readState(db: Database, subject: AvatarSubject): Promise<AvatarState | null> {
  return subject.kind === "human"
    ? queries.user.getLiveHumanAvatarState(db, subject.id)
    : queries.communityBot.getLiveBotAvatar(db, subject.id)
}

async function copyCurrentToAlias(
  db: Database,
  bucket: AvatarBucket,
  subject: AvatarSubject,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ALIAS_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const before = await readState(db, subject)
    const objectKey = before?.avatarObjectKey
    if (!before || before.avatarVersion <= 0 || !objectKey || !ownsChild(subject, objectKey)) {
      return false
    }

    const object = await bucket.get(objectKey)
    if (!object) return false
    const bytes = await object.arrayBuffer()
    await bucket.put(aliasKey(subject), bytes, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    })

    const after = await readState(db, subject)
    if (
      after?.avatarVersion === before.avatarVersion
      && after.avatarObjectKey === objectKey
    ) {
      return true
    }
  }
  return false
}

export async function ensureAvatarAliasPresent(
  db: Database,
  bucket: AvatarBucket,
  subject: AvatarSubject,
): Promise<boolean> {
  if (await bucket.head(aliasKey(subject))) return true
  if (!(await copyCurrentToAlias(db, bucket, subject))) return false
  return Boolean(await bucket.head(aliasKey(subject)))
}

export async function cleanupAvatarCandidate(
  db: Database,
  bucket: Pick<R2Bucket, "delete">,
  subject: AvatarSubject,
  candidate: string | null | undefined,
): Promise<"deleted" | "retained_current" | "retained_unowned" | "retained_unverified"> {
  if (!candidate || !ownsChild(subject, candidate)) return "retained_unowned"

  let current: AvatarState | null
  try {
    current = await readState(db, subject)
  } catch {
    return "retained_unverified"
  }
  if (current?.avatarObjectKey === candidate) return "retained_current"

  await bucket.delete(candidate)
  return "deleted"
}

async function reconcileAvatarMedia(
  db: Database,
  bucket: AvatarBucket,
  input: { subject: AvatarSubject; candidates: Array<string | null | undefined> },
): Promise<void> {
  try {
    if (!(await copyCurrentToAlias(db, bucket, input.subject))) {
      log.warn("community_avatar_alias_reconciliation_incomplete", {
        subjectKind: input.subject.kind,
        phase: "copy_current",
      })
    }
  } catch (error) {
    log.warn("community_avatar_alias_reconciliation_failed", {
      subjectKind: input.subject.kind,
      phase: "copy_current",
      errorCategory: communityMediaCleanupErrorCategory(error),
    })
  }

  for (const candidate of new Set(input.candidates)) {
    try {
      await cleanupAvatarCandidate(db, bucket, input.subject, candidate)
    } catch (error) {
      log.warn("community_avatar_child_cleanup_failed", {
        subjectKind: input.subject.kind,
        phase: "exact_candidate",
        errorCategory: communityMediaCleanupErrorCategory(error),
      })
    }
  }
}

export function scheduleAvatarMediaReconciliation(
  db: Database,
  bucket: AvatarBucket,
  input: { subject: AvatarSubject; candidates: Array<string | null | undefined> },
): Promise<void> {
  const work = reconcileAvatarMedia(db, bucket, input)
  try {
    getCloudflareContext().ctx.waitUntil(work)
  } catch {
    // Tests and non-Workers runtimes may not expose an execution context.
  }
  return work
}
