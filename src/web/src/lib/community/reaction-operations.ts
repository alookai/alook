import {
  formatHandle,
  isUniqueConstraintError,
  MAX_EMOJI_BYTES,
  queries,
  WS_EVENTS,
} from "@alook/shared"
import type { Database, MessagePropertyEmojiEntry } from "@alook/shared"
import { fanOutToChannel, fanOutToDM } from "@/lib/community/fanout"
import { authorizeReaction } from "@/lib/community/reaction-access"

type OperationError = { ok: false; status: 400 | 401 | 403 | 404; error: string }
type OperationOk<T> = { ok: true; value: T }
type OperationResult<T> = OperationOk<T> | OperationError

function validateEmoji(raw: unknown): OperationResult<string> {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, status: 400, error: "emoji must be a non-empty string" }
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_EMOJI_BYTES) {
    return { ok: false, status: 400, error: "emoji too long" }
  }
  return { ok: true, value: raw }
}

function fanOutReaction(
  access: Extract<Awaited<ReturnType<typeof authorizeReaction>>, { ok: true }>,
  event: {
    type: typeof WS_EVENTS.REACTION_ADD | typeof WS_EVENTS.REACTION_REMOVE
    messageId: string
    userId: string
    emoji: string
    channelId: string
  },
): void {
  if (access.isDm) fanOutToDM(access.channelId, event)
  else fanOutToChannel(access.channelId, event)
}

export async function setReactionForActor(
  db: Database,
  input: { messageId: string; userId: string; emoji: unknown },
): Promise<OperationResult<{ emoji: string; changed: boolean; reaction?: unknown }>> {
  const emoji = validateEmoji(input.emoji)
  if (!emoji.ok) return emoji
  const access = await authorizeReaction(db, input.messageId, input.userId)
  if (!access.ok) return access

  let reaction: unknown
  try {
    reaction = await queries.communityReaction.addReaction(db, {
      messageId: input.messageId,
      userId: input.userId,
      emoji: emoji.value,
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { ok: true, value: { emoji: emoji.value, changed: false } }
    }
    throw error
  }

  fanOutReaction(access, {
    type: WS_EVENTS.REACTION_ADD,
    messageId: input.messageId,
    userId: input.userId,
    emoji: emoji.value,
    channelId: access.channelId,
  })
  return { ok: true, value: { emoji: emoji.value, changed: true, reaction } }
}

export async function removeReactionForActor(
  db: Database,
  input: { messageId: string; userId: string; emoji: unknown },
): Promise<OperationResult<{ emoji: string; changed: boolean }>> {
  const emoji = validateEmoji(input.emoji)
  if (!emoji.ok) return emoji
  const access = await authorizeReaction(db, input.messageId, input.userId)
  if (!access.ok) return access

  const removed = await queries.communityReaction.removeReaction(db, {
    messageId: input.messageId,
    userId: input.userId,
    emoji: emoji.value,
  })
  if (!removed) return { ok: true, value: { emoji: emoji.value, changed: false } }

  fanOutReaction(access, {
    type: WS_EVENTS.REACTION_REMOVE,
    messageId: input.messageId,
    userId: input.userId,
    emoji: emoji.value,
    channelId: access.channelId,
  })
  return { ok: true, value: { emoji: emoji.value, changed: true } }
}

export async function listReactionsForActor(
  db: Database,
  input: { messageId: string; userId: string },
): Promise<OperationResult<MessagePropertyEmojiEntry[]>> {
  const access = await authorizeReaction(db, input.messageId, input.userId)
  if (!access.ok) return access

  const [reactions, actors] = await Promise.all([
    queries.communityReaction.listReactionsByMessageIds(db, [input.messageId], input.userId),
    queries.communityReaction.getReactionDetailsActors(db, input.messageId, access.scope),
  ])
  const handles = new Map(actors.map((actor) => [
    actor.userId,
    actor.profile
      ? `@${formatHandle(actor.profile.name, actor.profile.discriminator)}`
      : "Unknown user",
  ]))
  const byEmoji = new Map<string, { actorIds: Set<string>; me: boolean }>()
  for (const reaction of reactions) {
    const group = byEmoji.get(reaction.emoji) ?? { actorIds: new Set<string>(), me: false }
    group.actorIds.add(reaction.userId)
    group.me ||= reaction.userId === input.userId
    byEmoji.set(reaction.emoji, group)
  }
  return {
    ok: true,
    value: [...byEmoji.entries()]
      .sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1)
      .map(([emoji, group]) => ({
        emoji,
        actors: [...group.actorIds]
          .map((userId) => handles.get(userId) ?? "Unknown user")
          .sort((a, b) => a === b ? 0 : a < b ? -1 : 1),
        me: group.me,
      })),
  }
}
