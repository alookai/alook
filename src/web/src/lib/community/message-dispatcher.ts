import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  deriveCommunityDeliveryOperationId,
  WS_EVENTS,
  createLogger,
  queries,
  withD1Retry,
  type CommunityMessageCreate,
  type CommunityDeliveryOperationId,
  type Database,
  type MessageDeliveryBatch,
  type WakePayload,
} from "@alook/shared"
import { mapMessageForWs } from "./message-payload"
import { sendMessageDeliveryBatch } from "./message-delivery-transport"
import { enqueueBotWakePayloads } from "./wake-producer"
import { attachmentThumbnailUrl, attachmentUrl } from "./storage"

const log = createLogger({ service: "committed-message-dispatcher" })

export type CommittedMessageStructuralOutcome = {
  /** A participant row inserted by this exact message write. */
  memberAddedUserId?: string
  /** Existing thread-open collision suppression; no audience/policy input. */
  suppressParentProjection?: boolean
}

export type MessageDeliveryPlan = MessageDeliveryBatch & {
  operationId: CommunityDeliveryOperationId
  wakeBotUserIds: string[]
}

const recipientRetryRoute = {
  "channel-type": "message-dispatcher:channel-type",
  "thread-participants": "message-dispatcher:thread-participants",
  "dm-members": "message-dispatcher:dm-members",
  "scope-members": "message-dispatcher:scope-members",
} as const

async function resolveRecipients(db: Database, channelId: string): Promise<string[]> {
  return queries.communityMembersResolver.resolveChannelRecipientUserIds(
    db,
    channelId,
    (phase, query) => withD1Retry(query, { route: recipientRetryRoute[phase] }),
  )
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export async function planCommittedMessage(
  db: Database,
  messageId: string,
  structural: CommittedMessageStructuralOutcome = {},
): Promise<MessageDeliveryPlan> {
  const message = await withD1Retry(
    () => queries.communityMessage.getMessage(db, messageId),
    { route: "message-dispatcher:message" },
  )
  if (!message) throw new Error("committed message not found")
  const [channel, attentionUserIds, attachments, clientNonce] = await Promise.all([
    withD1Retry(
      () => queries.communityChannel.getChannel(db, message.channelId),
      { route: "message-dispatcher:channel" },
    ),
    withD1Retry(
      () => queries.communityMention.listMessageMentionUserIds(db, messageId),
      { route: "message-dispatcher:attention" },
    ),
    withD1Retry(
      () => queries.communityAttachment.listMessageAttachments(db, messageId),
      { route: "message-dispatcher:attachments" },
    ),
    withD1Retry(
      () => queries.communityMessage.getMessageClientNonceForDelivery(db, messageId),
      { route: "message-dispatcher:client-nonce" },
    ),
  ])
  if (!channel || channel.id !== message.channelId) {
    throw new Error("committed message scope not found")
  }

  const candidateContentUserIds = unique(await resolveRecipients(db, channel.id))
  const attentionIds = unique(attentionUserIds).filter((id) => id !== message.authorId)
  const eligibilityUserIds = unique([...candidateContentUserIds, ...attentionIds])

  const [eligibility, replyTarget] = await Promise.all([
    withD1Retry(
      () => queries.communityNotificationEligibility.resolveNotificationEligibilityForUsers(
        db,
        eligibilityUserIds,
        message.id,
      ),
      { route: "message-dispatcher:eligibility" },
    ),
    message.replyToId
      ? withD1Retry(
          () => queries.communityMessage.getMessageInScope(
            db,
            message.replyToId!,
            { channelId: message.channelId },
          ),
          { route: "message-dispatcher:reply" },
        )
      : Promise.resolve(null),
  ])

  const contentUserIds = candidateContentUserIds.filter(
    (id) => eligibility.get(id)?.isReadable,
  )
  const notifyContentUserIds = contentUserIds.filter((id) => id !== message.authorId)
  const wakeCandidates = await withD1Retry(
    () => queries.communityBot.findWakeCandidates(db, {
      recipients: notifyContentUserIds,
      channelId: message.channelId,
      newSeq: message.seq,
    }),
    { route: "message-dispatcher:wake-candidates" },
  )

  const allowed = (userId: string) => {
    const state = eligibility.get(userId)
    return Boolean(
      state?.isReadable
      && state.isUnread
      && queries.communityNotificationSetting.policyAllows(
        state.currentLevel,
        state.hasAttention,
      )
    )
  }
  const unreadMentionUserIds = notifyContentUserIds.filter((id) => {
    const state = eligibility.get(id)
    return allowed(id) && Boolean(state?.hasAttention)
  })
  const unreadMentionSet = new Set(unreadMentionUserIds)
  const unreadPlainUserIds = notifyContentUserIds.filter(
    (id) => allowed(id) && !unreadMentionSet.has(id),
  )
  const mentionUserIds = attentionIds.filter((id) => {
    const state = eligibility.get(id)
    return allowed(id) && Boolean(state?.hasAttention)
  })
  const notifyContentSet = new Set(notifyContentUserIds)
  const wakeBotUserIds = unique(
    wakeCandidates
      .map((candidate) => candidate.botUserId)
      .filter((id) => notifyContentSet.has(id) && allowed(id)),
  )

  const replyMap = new Map<string, { id: string; authorName: string; content: string | null }>()
  if (replyTarget) {
    replyMap.set(replyTarget.id, {
      id: replyTarget.id,
      authorName: replyTarget.authorName,
      content: replyTarget.content,
    })
  }
  const messageEvent: CommunityMessageCreate = {
    type: WS_EVENTS.MESSAGE_CREATE,
    channelId: message.channelId,
    ...(channel.serverId ? { serverId: channel.serverId } : {}),
    ...(channel.parentChannelId ? { parentChannelId: channel.parentChannelId } : {}),
    message: mapMessageForWs(message, {
      replyMap,
      clientNonce: clientNonce ?? undefined,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        url: attachmentUrl(attachment.targetId, attachment.id),
        ...(attachment.thumbnailR2Key
          ? { thumbnailUrl: attachmentThumbnailUrl(attachment.targetId, attachment.id) }
          : {}),
        contentType: attachment.contentType ?? undefined,
        size: attachment.size ?? undefined,
        width: attachment.width ?? undefined,
        height: attachment.height ?? undefined,
      })),
    }),
  }

  const includeParent = Boolean(channel.parentChannelId && !structural.suppressParentProjection)
  const parentProjectionUserIds = includeParent
    ? unique(await resolveRecipients(db, channel.parentChannelId!))
    : []
  const parentProjection = includeParent
    ? {
        type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
        parentChannelId: channel.parentChannelId!,
        channelId: channel.id,
        changes: {
          messageCount: channel.messageCount,
          lastMessageAt: channel.lastMessageAt ?? message.createdAt,
        },
      } as const
    : undefined

  if (
    structural.memberAddedUserId
    && (!channel.serverId || !contentUserIds.includes(structural.memberAddedUserId))
  ) {
    throw new Error("committed participant outcome is outside message scope")
  }

  return {
    operationId: await deriveCommunityDeliveryOperationId(message.id),
    messageId: message.id,
    messageEvent,
    contentUserIds,
    unreadPlainUserIds,
    unreadMentionUserIds,
    mentionUserIds,
    wakeBotUserIds,
    ...(structural.memberAddedUserId && channel.serverId
      ? {
          memberAdded: {
            userId: structural.memberAddedUserId,
            serverId: channel.serverId,
            channelId: channel.id,
          },
        }
      : {}),
    ...(parentProjection
      ? { parentProjection, parentProjectionUserIds }
      : {}),
  }
}

async function runCommittedMessageDispatch(
  db: Database,
  messageId: string,
  structural: CommittedMessageStructuralOutcome,
): Promise<void> {
  const startedAt = Date.now()
  const plan = await planCommittedMessage(db, messageId, structural)
  const browserBatch: MessageDeliveryBatch = {
    messageId: plan.messageId,
    messageEvent: plan.messageEvent,
    contentUserIds: plan.contentUserIds,
    unreadPlainUserIds: plan.unreadPlainUserIds,
    unreadMentionUserIds: plan.unreadMentionUserIds,
    mentionUserIds: plan.mentionUserIds,
    ...(plan.memberAdded ? { memberAdded: plan.memberAdded } : {}),
    ...(plan.parentProjection
      ? {
          parentProjection: plan.parentProjection,
          parentProjectionUserIds: plan.parentProjectionUserIds,
        }
      : {}),
  }
  const wakePayloads: WakePayload[] = plan.wakeBotUserIds.map((botUserId) => ({
    messageId: plan.messageId,
    botUserId,
  }))
  const [browser, wake] = await Promise.allSettled([
    sendMessageDeliveryBatch(browserBatch, plan.operationId),
    enqueueBotWakePayloads(wakePayloads),
  ])
  if (browser.status === "rejected") {
    log.warn("committed_message_browser_delivery_failed", {
      messageId,
      err: String(browser.reason),
    })
  }
  if (wake.status === "rejected") {
    log.warn("committed_message_wake_delivery_failed", {
      messageId,
      err: String(wake.reason),
    })
  }
  log.info("committed_message_dispatch_complete", {
    messageId,
    contentCount: plan.contentUserIds.length,
    unreadCount: plan.unreadPlainUserIds.length + plan.unreadMentionUserIds.length,
    mentionCount: plan.mentionUserIds.length,
    wakeCount: plan.wakeBotUserIds.length,
    parentCount: plan.parentProjectionUserIds?.length ?? 0,
    durationMs: Date.now() - startedAt,
  })
}

/**
 * Register one committed delivery with the request lifetime. Delivery is a
 * fail-open realtime hint: a transport or planning failure never rejects the
 * already successful message mutation.
 */
export function dispatchCommittedMessage(
  db: Database,
  messageId: string,
  structural: CommittedMessageStructuralOutcome = {},
): Promise<void> {
  const work = runCommittedMessageDispatch(db, messageId, structural).catch((err) => {
    log.warn("committed_message_dispatch_failed", { messageId, err: String(err) })
  })
  try {
    getCloudflareContext().ctx.waitUntil(work)
  } catch {
    // Unit tests and non-Cloudflare callers may not expose a request context.
  }
  return work
}
