import { BUSINESS_SCHEMA_VERSION, CommunityMessageResourceSchema, type CommunityMessageResource } from "@alook/shared"
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

function projectMessageRichContent(value: unknown): Pick<Msg, "attachments" | "embeds"> {
  const { attachments, embeds } = richContentSchema.parse(value)
  return {
    ...(attachments ? { attachments: attachments.map(presentMessageAttachment) } : {}),
    ...(embeds ? { embeds: embeds.flatMap((value) => { const embed = projectEmbed(value); return embed ? [embed] : [] }) } : {}),
  }
}

export function presentCanonicalMessage(message: CommunityMessageResource): Msg {
  const { channelId: _channelId, replyToId: _replyToId, clientNonce, authorAvatar, attachments: _attachments, embeds: _embeds, thread, ...fields } = message
  return {
    ...fields,
    ...(authorAvatar === undefined ? {} : { authorAvatar: authorAvatar ?? avatarInitial(message.authorName ?? "") }),
    ...(clientNonce != null ? { clientNonce } : {}),
    ...(thread ? { thread: presentMessageThread(thread) } : {}),
    ...projectMessageRichContent(message),
  }
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
