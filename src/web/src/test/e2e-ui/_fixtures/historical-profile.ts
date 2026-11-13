import { createRequire } from "module"
import { resolve } from "path"
import type { Database } from "../../../../../shared/src/db/index"
import { createMessage } from "../../../../../shared/src/db/queries/community/message"
import { communityChannel, communityMessage, communityMessageAttachment, communityMessageSeq, communityReadState, communityReadStateRevision } from "../../../../../shared/src/db/community-schema"
import { user } from "../../../../../shared/src/db/schema"
import type { UserKey } from "../_setup/users"

type Condition = ReturnType<typeof communityMessage.id.getSQL>
const { and, asc, eq, inArray } = createRequire(resolve(__dirname, "../../../../../shared/package.json"))("drizzle-orm") as {
  and: (...conditions: Array<Condition | undefined>) => Condition | undefined
  asc: (column: unknown) => Condition
  eq: (column: unknown, value: unknown) => Condition
  inArray: (column: unknown, values: readonly unknown[]) => Condition
}

export type HistoricalRow = { author: UserKey } & (
  | { content: string; create?: never }
  | { content?: never; create: () => Promise<{ messageId: string; attachmentId: string }> }
)
export type HistoricalActor = { role: UserKey; id: string; email: string }

export async function fillHistoricalProfile(db: Database, input: {
  channelId: string
  actors: readonly HistoricalActor[]
  rows: readonly HistoricalRow[]
  idPrefix: string
  register: (id: string) => void
  assertActive: () => void
}) {
  input.assertActive()
  const { channelId, actors, rows } = input
  if (rows.length === 0 || actors.length === 0 || new Set(actors.map(actor => actor.id)).size !== actors.length) throw new Error("History requires distinct case actors and a nonempty profile")
  const authorFor = (role: UserKey) => {
    const actor = actors.find(actor => actor.role === role)
    if (!actor) throw new Error(`Foreign history author: ${role}`)
    return actor
  }
  for (const row of rows) authorFor(row.author)
  const actorIds = actors.map(actor => actor.id)
  const actualActors = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, actorIds))
  if (actualActors.length !== actors.length || actors.some(actor => !actualActors.some(actual => actual.id === actor.id && actual.email === actor.email))) throw new Error("History DB does not contain this case's actor identities")
  const readChannel = async () => (await db.select({ id: communityChannel.id, count: communityChannel.messageCount, lastMessageAt: communityChannel.lastMessageAt })
    .from(communityChannel).where(eq(communityChannel.id, channelId)))[0]
  const readMessages = () => db.select().from(communityMessage).where(eq(communityMessage.channelId, channelId))
    .orderBy(asc(communityMessage.createdAt), asc(communityMessage.id))
  const readStates = () => db.select().from(communityReadState)
    .where(and(eq(communityReadState.channelId, channelId), inArray(communityReadState.userId, actorIds)))
  const readRevisions = () => db.select().from(communityReadStateRevision).where(inArray(communityReadStateRevision.userId, actorIds))
  const channel = await readChannel()
  const existingCounter = await db.select().from(communityMessageSeq).where(eq(communityMessageSeq.channelId, channelId))
  if (!channel || channel.count !== 0 || existingCounter.some(row => row.nextSeq !== 0) || (await readMessages()).length !== 0) throw new Error("History requires this case's existing empty channel")
  const beforeStates = await readStates()
  const beforeRevisions = await readRevisions()
  if (beforeStates.some(state => state.lastReadSeq !== 0)) throw new Error("History requires the original unread case baseline")
  const ids: string[] = []
  const attachments = new Map<string, string>()
  for (const [index, row] of rows.entries()) {
    input.assertActive()
    if (row.create) {
      const created = await row.create()
      ids.push(created.messageId)
      attachments.set(created.messageId, created.attachmentId)
    } else {
      const created = await createMessage(db, {
        id: `${input.idPrefix}_${String(index).padStart(6, "0")}`,
        channelId, authorId: authorFor(row.author).id, authorKind: "human", content: row.content,
      })
      ids.push(created.id)
    }
    input.register(ids.at(-1)!)
  }
  input.assertActive()
  const actual = await readMessages()
  if (actual.length !== rows.length || actual.some((message, index) => {
    const expected = rows[index]!
    return message.id !== ids[index] || message.seq !== index + 1 || message.authorId !== authorFor(expected.author).id
      || message.type !== "default" || message.channelId !== channelId
      || message.content !== (expected.create ? `[alook-html-preview](${attachments.get(message.id)})` : expected.content)
  })) throw new Error("History readback violates complete profile, cursor order, author or sequence")
  const finalChannel = await readChannel()
  const counter = await db.select().from(communityMessageSeq).where(eq(communityMessageSeq.channelId, channelId))
  if (finalChannel?.count !== rows.length || finalChannel.lastMessageAt !== actual.at(-1)?.createdAt || counter.length !== 1 || counter[0]!.nextSeq !== rows.length) throw new Error("History canonical channel/counter readback failed")
  const actualAttachments = await db.select({ messageId: communityMessageAttachment.messageId, attachmentId: communityMessageAttachment.attachmentId, position: communityMessageAttachment.position })
    .from(communityMessageAttachment).innerJoin(communityMessage, eq(communityMessage.id, communityMessageAttachment.messageId))
    .where(eq(communityMessage.channelId, channelId))
  if (actualAttachments.length !== attachments.size || actualAttachments.some(row => attachments.get(row.messageId) !== row.attachmentId || row.position !== 0)) throw new Error("History attachment relationship readback failed")
  const states = await readStates()
  const revisions = await readRevisions()
  for (const actor of actors) {
    const authored = actual.filter(message => message.authorId === actor.id)
    const last = authored.at(-1)
    const state = states.find(state => state.userId === actor.id)
    const revision = revisions.find(row => row.userId === actor.id)?.revision ?? 0
    const beforeRevision = beforeRevisions.find(row => row.userId === actor.id)?.revision ?? 0
    if (revision !== beforeRevision + authored.length) throw new Error("History human read revision readback failed")
    if (last) {
      if (state?.lastReadSeq !== last.seq || state.lastReadMessageId !== last.id || state.lastReadAt !== last.createdAt) throw new Error("History author watermark readback failed")
    } else if (JSON.stringify(state) !== JSON.stringify(beforeStates.find(state => state.userId === actor.id))) throw new Error("History advanced a nonauthor's read state")
  }
  return { ids, count: actual.length, firstSeq: actual[0]!.seq, lastSeq: actual.at(-1)!.seq }
}
