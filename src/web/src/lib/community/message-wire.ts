import { BUSINESS_SCHEMA_VERSION, CommunityMessageResourceSchema, extractDecisionCardFromEmbeds, messagePreview, type CommunityMessageResource } from "@alook/shared"
import { MessageEmbedSchema, type Msg, type CanonicalMessage } from "@/lib/community/models/message"
import { avatarInitial } from "@/lib/community/avatar"
import { presentMessageAttachment } from "@/lib/community/attachment-presentation"

type UiEmbed = NonNullable<Msg["embeds"]>[number]
const richContentSchema = CommunityMessageResourceSchema.pick({ attachments: true, embeds: true }).strip()

export type PostedMessage = CommunityMessageResource

function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(omitUndefined) as T
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)
    .map(([key, field]) => [key, omitUndefined(field)])) as T
}

function projectEmbed(value: unknown): UiEmbed | undefined {
  const parsed = MessageEmbedSchema.safeParse(value)
  return parsed.success ? omitUndefined(parsed.data) : undefined
}

type RichContentProjection = Pick<Msg, "attachments" | "embeds" | "decisionCard">
const NO_REPLY_TARGET: object = {}
const richContentCache = new WeakMap<CommunityMessageResource, RichContentProjection>()
const presentedMessageCache = new WeakMap<CommunityMessageResource, WeakMap<object, Msg>>()

function projectMessageRichContent(value: CommunityMessageResource): RichContentProjection {
  const cached = richContentCache.get(value)
  if (cached) return cached
  const { attachments, embeds } = richContentSchema.parse(value)
  const extracted = extractDecisionCardFromEmbeds(embeds)
  const genericEmbeds = extracted.otherEmbeds?.flatMap((entry) => {
    const embed = projectEmbed(entry)
    return embed ? [embed] : []
  })
  const projected: RichContentProjection = {
    ...(attachments ? { attachments: attachments.map(presentMessageAttachment) } : {}),
    ...(embeds
      ? { embeds: genericEmbeds ?? [] }
      : {}),
    ...(extracted.card ? { decisionCard: extracted.card } : {}),
  }
  richContentCache.set(value, projected)
  return projected
}

export function presentCanonicalMessage(message: CommunityMessageResource, replyTarget?: CommunityMessageResource): Msg {
  const resolvedReply = message.replyTo && replyTarget?.id === message.replyTo.id && replyTarget.channelId === message.channelId ? replyTarget : undefined
  const replyKey: object = resolvedReply ?? NO_REPLY_TARGET
  let byReply = presentedMessageCache.get(message)
  const cached = byReply?.get(replyKey)
  if (cached) return cached

  const { channelId: _channelId, replyToId: _replyToId, clientNonce, authorAvatar, attachments: _attachments, embeds: _embeds, thread, replyTo, ...fields } = message
  const presented: Msg = {
    ...fields,
    ...(replyTo ? { replyTo: { ...replyTo, text: !replyTo.deleted && resolvedReply ? messagePreview(resolvedReply) : "", ...(!replyTo.deleted && !resolvedReply ? { loading: true } : {}) } } : {}),
    ...(authorAvatar === undefined ? {} : { authorAvatar: authorAvatar ?? avatarInitial(message.authorName ?? "") }),
    ...(clientNonce != null ? { clientNonce } : {}),
    ...(thread ? { thread: presentMessageThread(thread) } : {}),
    ...projectMessageRichContent(message),
  }
  if (!byReply) {
    byReply = new WeakMap()
    presentedMessageCache.set(message, byReply)
  }
  byReply.set(replyKey, presented)
  return presented
}

function presentMessageThread(thread: NonNullable<CommunityMessageResource["thread"]>): NonNullable<Msg["thread"]> {
  const { participants, ...fields } = thread
  return { ...fields,
    ...(participants ? { participants: participants.map((participant) => ({
      ...participant, avatar: participant.avatar ?? avatarInitial(participant.name),
    })) } : {}),
  }
}

export function projectCommunityMessageCreate(message: unknown, channelId: string, contract: number = BUSINESS_SCHEMA_VERSION): CanonicalMessage {
  if (contract !== BUSINESS_SCHEMA_VERSION) throw new Error("Message resource protocol mismatch")
  const full = CommunityMessageResourceSchema.parse(message)
  if (full.channelId !== channelId) throw new Error("Message resource scope mismatch")
  return full
}

export function projectPostedMessage(message: PostedMessage, clientNonce: string, channelId: string): CanonicalMessage {
  const full = CommunityMessageResourceSchema.parse(message)
  if (full.channelId !== channelId || (clientNonce && full.clientNonce !== clientNonce)) throw new Error("Posted message confirmation mismatch")
  return full
}
