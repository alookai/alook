import { z } from "zod"
import { BUSINESS_SCHEMA_VERSION } from "./business-schema-version"
import { CommunityChannelResourceSchema, CommunityResourceBundleSchema } from "./community-resources"

const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)))
export const CommunityForumSidebarChannelSummarySchema = CommunityChannelResourceSchema.pick({
  id: true, name: true, serverId: true, parentChannelId: true, parentMessageId: true,
}).extend({
  serverId: CommunityChannelResourceSchema.shape.serverId.unwrap(),
  parentChannelId: CommunityChannelResourceSchema.shape.parentChannelId.unwrap(),
  parentMessageId: CommunityChannelResourceSchema.shape.parentMessageId.unwrap(),
  activityAt: timestamp, expiresAt: timestamp, unread: z.boolean(),
})

export const CommunityForumSidebarEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(BUSINESS_SCHEMA_VERSION), serverId: z.string().min(1),
  channels: z.array(CommunityForumSidebarChannelSummarySchema),
  canonicalChannels: z.array(CommunityForumSidebarChannelSummarySchema),
  retainedChannel: CommunityForumSidebarChannelSummarySchema.nullable(),
  retainedDisposition: z.enum(["eligible", "opener-archived", "genuine-negative"]).nullable(),
  resources: CommunityResourceBundleSchema,
  serverNow: timestamp,
}).superRefine((data, ctx) => {
  const selected = [...data.canonicalChannels, ...(data.retainedChannel ? [data.retainedChannel] : [])]
  if (data.resources.servers.some(row => row.id !== data.serverId) || data.resources.channels.some(row => row.serverId !== data.serverId)
    || new Set(data.channels.map(row => row.id)).size !== data.channels.length
    || new Set(data.canonicalChannels.map(row => row.id)).size !== data.canonicalChannels.length
    || data.canonicalChannels.some(row => data.canonicalChannels.filter(other => other.parentChannelId === row.parentChannelId).length > 5)
    || data.channels.some(row => !selected.some(other => other.id === row.id))
    || (data.retainedDisposition === "eligible") !== (data.retainedChannel !== null)
    || selected.some(row => !data.resources.channels.some(channel => channel.id === row.id && channel.type === "thread"
      && channel.serverId === row.serverId && channel.parentChannelId === row.parentChannelId && channel.parentMessageId === row.parentMessageId)
      || !data.resources.messages.some(message => message.id === row.parentMessageId && message.channelId === row.parentChannelId)
      || !data.resources.memberships.some(member => member.channelId === row.id && member.userId === data.resources.viewerId && member.relation === "notify"))) {
    ctx.addIssue({ code: "custom", message: "Forum sidebar resource closure mismatch" })
  }
})

export type CommunityForumSidebarEnvelope = z.infer<typeof CommunityForumSidebarEnvelopeSchema>
