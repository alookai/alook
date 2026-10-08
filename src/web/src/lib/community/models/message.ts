import { z } from "zod"
import type { CommunityChannelResource, CommunityMessageResource, CommunityMessageAttachment } from "@alook/shared"
import { deriveView, viewEvidence } from "@/lib/observability/data-source"

// ── Messages ───────────────────────────────────────────────────────────────
type AttachmentMetadata = Pick<CommunityMessageAttachment, "name" | "url" | "contentType" | "sizeBytes">

export type FileAttachment = AttachmentMetadata & { kind: "file"; size: string }

export type Attachment =
  | (AttachmentMetadata & { kind: "image"; thumbnailUrl?: string; width?: number; height?: number })
  | FileAttachment

export type ImagePreview = {
  originalUrl: string
  thumbnailUrl?: string
  name: string
  width?: number
  height?: number
}

const optionalString = z.string().optional().catch(undefined)
const optionalNumber = z.number().optional().catch(undefined)
const optionalObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).optional().catch(undefined)

export const MessageEmbedSchema = z.object({
  title: z.string(),
  provider: optionalString, url: optionalString, desc: optionalString, color: optionalString,
  image: optionalObject({ url: z.string(), width: optionalNumber, height: optionalNumber }),
  thumbnail: optionalObject({ url: z.string() }),
  fields: z.array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional().catch(undefined) }).optional().catch(undefined))
    .transform((rows) => { const valid = rows.filter((row) => row !== undefined); return valid.length ? valid : undefined }).optional().catch(undefined),
  footer: optionalObject({ text: z.string(), iconUrl: optionalString }),
  author: optionalObject({ name: z.string(), url: optionalString, iconUrl: optionalString }),
})

type Embed = z.infer<typeof MessageEmbedSchema>

export type Reaction = NonNullable<CommunityMessageResource["reactions"]>[number]
export type ReplyTarget = Pick<NonNullable<CommunityMessageResource["replyTo"]>, "id" | "authorName" | "text">

export type Msg = Pick<CommunityMessageResource, "id" | "type"> & Partial<Omit<CommunityMessageResource,
  "id" | "type" | "channelId" | "replyToId" | "clientNonce" | "attachments" | "embeds"
>> & {
  color?: string
  failed?: boolean
  clientNonce?: string
  attachments?: Attachment[]
  embeds?: Embed[]
}

export type MessageInput = Pick<Msg, "id"> & Partial<Msg>

export function applyMessageReaction(source: Msg["reactions"], emoji: string, userId: string, add: boolean, viewerId: string | null): Reaction[] {
  const rows = (source ?? []).map((row) => ({ ...row, userIds: [...row.userIds] }))
  const row = rows.find((candidate) => candidate.emoji === emoji)
  if (add) {
    if (row && !row.userIds.includes(userId)) row.userIds.push(userId)
    else if (!row) rows.push({ emoji, count: 1, me: userId === viewerId, userIds: [userId] })
  } else if (row) row.userIds = row.userIds.filter((id) => id !== userId)
  return rows.filter((row) => row.userIds.length).map((row) => ({ ...row, count: row.userIds.length, me: viewerId !== null && row.userIds.includes(viewerId) }))
}

export function messageProfileIds(message: Pick<Msg, "authorId" | "replyTo" | "thread" | "approval">): string[] {
  return [
    ...(message.authorId ? [message.authorId] : []),
    ...(message.replyTo?.authorId ? [message.replyTo.authorId] : []),
    ...(message.thread?.participants ?? []).map((participant) => participant.id),
    ...[message.approval?.otherProfile, message.approval?.botProfile, message.approval?.waitingOnProfile]
      .flatMap((profile) => profile?.id ? [profile.id] : []),
  ]
}

// `grouped` is a RENDER-TIME decision (computed by `message-list.tsx`'s
// cluster-building `useMemo`, based on adjacent messages' author/timestamp)
// — never a fact about a message itself, so it never belonged on `Msg`
// (#7). `<Message>` and any other consumer that needs the clustering
// decision takes a `RenderMsg`, not a bare `Msg` with `grouped` spread on.
export type RenderMsg = Msg & { grouped: boolean }

// ── Threads / forum ──────────────────────────────────────────────────────────
// Child-thread summaries shown in side panels and forum lists. Actual
// message content for a thread or post is loaded into `ctx.messages` once the
// user navigates into the child channel — these summaries don't carry messages.
export type Thread = Pick<CommunityChannelResource, "id" | "messageCount"> & {
  name: NonNullable<CommunityChannelResource["name"]>
  lastMessageAt: NonNullable<CommunityChannelResource["lastMessageAt"]>
  parent: Omit<NonNullable<CommunityMessageResource["replyTo"]>, "id" | "deleted">
  parentSeq?: CommunityMessageResource["seq"]
  openerMessageId?: CommunityMessageResource["id"]
}

export type ForumThread = Thread & Required<Pick<CommunityMessageResource,
  "authorId" | "authorAvatar" | "authorAvatarVersion"
>> & {
  openerMessageId: CommunityMessageResource["id"]
  openerCreatedAt?: CommunityMessageResource["createdAt"]
  tags: NonNullable<NonNullable<CommunityMessageResource["thread"]>["tags"]>
  preview: NonNullable<NonNullable<CommunityMessageResource["thread"]>["preview"]>
  participants: NonNullable<NonNullable<CommunityMessageResource["thread"]>["participants"]>
  participantCount: NonNullable<NonNullable<CommunityMessageResource["thread"]>["participantCount"]>
}

export type SendAttachment = {
  file: File
  thumbnailBlob?: Blob
  previewObjectUrl?: string
  width?: number
  height?: number
}

export type MessagesPage = {
  messages: Msg[]
  latestSeq?: number
  // Anchor / since mode
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  olderCursor?: string
  newerCursor?: string
  // Legacy (newest + older continuation) mode
  hasMore?: boolean
  cursor?: string
}

export type MessagesWindowPage = Omit<MessagesPage, "messages"> & { messages: Array<{ id: string; seq?: number }>; newestCursor?: string }

export function messageWindowPage(page: MessagesPage): MessagesWindowPage {
  const newest = [...page.messages].filter((message) => message.createdAt).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id)).at(-1)
  return deriveView({ ...page, messages: page.messages.map((message) => ({ id: message.id, ...(message.seq === undefined ? {} : { seq: message.seq }) })), ...(newest?.createdAt ? { newestCursor: `${newest.createdAt}|${newest.id}` } : {}) }, [viewEvidence(page)])
}

// Discriminated pageParam. The queryFn dispatches on `mode` — the URL param
// map is: newest → no param, older → cursor, newer/since → since, anchor →
// anchor. Since also powers bounded reconnect catch-up without refetching
// every cached historical page.
export type MessagesPageParam =
  | { mode: "newest" }
  | { mode: "anchor"; anchor: string }
  | { mode: "since"; since: string }
  | { mode: "older"; cursor: string }
  | { mode: "newer"; cursor: string }
