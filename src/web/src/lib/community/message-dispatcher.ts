import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  deriveCommunityDeliveryOperationId,
  formatHandle,
  MENTION_KIND,
  reachIsParticipantSet,
  WS_EVENTS,
  createLogger,
  queries,
  withD1Retry,
  type CommunityMessageCreate,
  type CommunityDeliveryOperationId,
  type Database,
  type MessageDeliveryBatch,
  type AlookQueueTask,
} from "@alook/shared"
import { mapMessageForWs } from "./message-payload"
import { sendMessageDeliveryBatch } from "./message-delivery-transport"
import { enqueueQueueTasks } from "./queue-producer"
import {
  selectJevWakeCandidates,
  type JevWakeGateInput,
} from "./jev-wake-gate"
import { attachmentThumbnailUrl, attachmentUrl } from "./storage"

const log = createLogger({ service: "committed-message-dispatcher" })
const RECENT_WAKE_CONTEXT_MESSAGES = 6

type WakeContextRow = Awaited<ReturnType<
  typeof queries.communityMessage.getWakeContextMessageInScope
>>

type WakeContextRole = JevWakeGateInput["conversation"]["messages"][number]["roles"][number]

type WakeContextPlan = {
  enabled: boolean
  channelId: string
  beforeSeq: number
  parentChannelId: string | null
  parentMessageId: string | null
  replyTarget: WakeContextRow
}

function buildWakeConversation(
  recent: NonNullable<WakeContextRow>[],
  replyTarget: WakeContextRow,
  replyAncestor: WakeContextRow,
  threadOpener: WakeContextRow,
  recentTruncated: boolean,
): JevWakeGateInput["conversation"] {
  const entries = new Map<string, {
    row: NonNullable<WakeContextRow>
    roles: Set<WakeContextRole>
    priority: number
  }>()
  const add = (
    row: WakeContextRow,
    role: WakeContextRole,
    priority: number,
  ) => {
    if (!row) return
    const existing = entries.get(row.id)
    if (existing) {
      existing.roles.add(role)
      existing.priority = Math.min(existing.priority, priority)
      return
    }
    entries.set(row.id, { row, roles: new Set([role]), priority })
  }

  for (const row of recent) add(row, "recent", 3)
  add(threadOpener, "thread_opener", 2)
  add(replyAncestor, "reply_ancestor", 1)
  add(replyTarget, "reply_target", 0)

  const ordered = [...entries.values()].sort((left, right) =>
    left.row.createdAt.localeCompare(right.row.createdAt)
      || left.row.seq - right.row.seq
      || left.row.id.localeCompare(right.row.id),
  )
  const roleOrder: WakeContextRole[] = [
    "reply_target",
    "reply_ancestor",
    "thread_opener",
    "recent",
  ]
  return {
    available: true,
    truncated: recentTruncated,
    messages: ordered.map(({ row, roles, priority }, order) => ({
      text: row.content,
      messageType: row.type,
      author: {
        kind: row.authorIsBot ? "bot" : "human",
        handle: formatHandle(row.authorName, row.authorDiscriminator),
      },
      roles: roleOrder.filter((role) => roles.has(role)),
      priority,
      order,
    })),
  }
}

function emptyWakeConversation(): JevWakeGateInput["conversation"] {
  return { available: true, messages: [], truncated: false }
}

async function loadWakeConversation(
  db: Database,
  messageId: string,
  plan: WakeContextPlan,
): Promise<JevWakeGateInput["conversation"]> {
  if (!plan.enabled) return emptyWakeConversation()
  try {
    const [recentContext, threadOpener, replyAncestor] = await Promise.all([
      withD1Retry(
        () => queries.communityMessage.listWakeContextMessagesBefore(db, {
          channelId: plan.channelId,
          beforeSeq: plan.beforeSeq,
          limit: RECENT_WAKE_CONTEXT_MESSAGES,
        }),
        { route: "message-dispatcher:wake-context-recent" },
      ),
      plan.parentChannelId && plan.parentMessageId
        ? withD1Retry(
            () => queries.communityMessage.getWakeContextMessageInScope(
              db,
              plan.parentMessageId!,
              { channelId: plan.parentChannelId! },
            ),
            { route: "message-dispatcher:wake-context-opener" },
          )
        : Promise.resolve(null),
      plan.replyTarget?.replyToId
        ? withD1Retry(
            () => queries.communityMessage.getWakeContextMessageInScope(
              db,
              plan.replyTarget!.replyToId!,
              { channelId: plan.channelId },
            ),
            { route: "message-dispatcher:wake-context-reply-ancestor" },
          )
        : Promise.resolve(null),
    ])
    return buildWakeConversation(
      recentContext.messages,
      plan.replyTarget,
      replyAncestor,
      threadOpener,
      recentContext.hasMore,
    )
  } catch {
    log.warn("committed_message_jev_context_failed_open", { messageId })
    return { ...emptyWakeConversation(), available: false }
  }
}

export type CommittedMessageStructuralOutcome = {
  /** A participant row inserted by this exact message write. */
  memberAddedUserId?: string
  /** Existing thread-open collision suppression; no audience/policy input. */
  suppressParentProjection?: boolean
}

export type MessageDeliveryPlan = MessageDeliveryBatch & {
  operationId: CommunityDeliveryOperationId
  wakeBotUserIds: string[]
  wakeGateInput: JevWakeGateInput
  pushUserIds: string[]
}

const recipientRetryRoute = {
  "channel-type": "message-dispatcher:channel-type",
  "thread-participants": "message-dispatcher:thread-participants",
  "dm-members": "message-dispatcher:dm-members",
  "scope-members": "message-dispatcher:scope-members",
  "readable-members": "message-dispatcher:readable-members",
} as const

async function resolveRecipients(db: Database, channelId: string): Promise<string[]> {
  return queries.communityMembersResolver.resolveChannelContentRecipientUserIds(
    db,
    channelId,
    (phase, query) => withD1Retry(query, { route: recipientRetryRoute[phase] }),
  )
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

async function planCommittedMessageBase(
  db: Database,
  messageId: string,
  structural: CommittedMessageStructuralOutcome = {},
): Promise<MessageDeliveryPlan & { wakeContextPlan: WakeContextPlan }> {
  const message = await withD1Retry(
    () => queries.communityMessage.getMessage(db, messageId),
    { route: "message-dispatcher:message" },
  )
  if (!message) throw new Error("committed message not found")
  const [channel, attentionTargets, attachments, clientNonce] = await Promise.all([
    withD1Retry(
      () => queries.communityChannel.getChannel(db, message.channelId),
      { route: "message-dispatcher:channel" },
    ),
    withD1Retry(
      () => queries.communityMention.listMessageAttentionTargets(db, messageId),
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

  const [contentCandidates, participantCandidates] = await Promise.all([
    resolveRecipients(db, channel.id),
    reachIsParticipantSet(channel.type)
      ? queries.communityMembersResolver.resolveChannelNotificationRecipientUserIds(
          db, channel.id,
          (phase, query) => withD1Retry(query, { route: recipientRetryRoute[phase] }),
        )
      : Promise.resolve(null),
  ])
  const notificationCandidates = participantCandidates ?? contentCandidates
  const contentUserIds = unique(contentCandidates)
  const candidateNotificationUserIds = unique(notificationCandidates).filter((id) => id !== message.authorId)
  const attentionIds = unique(attentionTargets.map((target) => target.userId))
    .filter((id) => id !== message.authorId)
  const eligibilityUserIds = unique([...candidateNotificationUserIds, ...attentionIds])

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
          () => queries.communityMessage.getWakeContextMessageInScope(
            db,
            message.replyToId!,
            { channelId: message.channelId },
          ),
          { route: "message-dispatcher:reply" },
        )
      : Promise.resolve(null),
  ])

  const contentSet = new Set(contentUserIds)
  const notificationUserIds = candidateNotificationUserIds.filter(
    (id) => contentSet.has(id),
  )
  const wakeCandidates = await withD1Retry(
    () => queries.communityBot.findWakeCandidates(db, {
      recipients: notificationUserIds,
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
  const unreadMentionUserIds = notificationUserIds.filter((id) => {
    const state = eligibility.get(id)
    return allowed(id) && Boolean(state?.hasAttention)
  })
  const unreadMentionSet = new Set(unreadMentionUserIds)
  const unreadPlainUserIds = notificationUserIds.filter(
    (id) => allowed(id) && !unreadMentionSet.has(id),
  )
  const mentionUserIds = attentionIds.filter((id) => {
    const state = eligibility.get(id)
    return allowed(id) && Boolean(state?.hasAttention)
  })
  const notificationSet = new Set(notificationUserIds)
  const eligibleWakeCandidates = wakeCandidates.filter(
    (candidate) => notificationSet.has(candidate.botUserId) && allowed(candidate.botUserId),
  )
  const shouldBuildWakeContext = channel.type !== "dm" && eligibleWakeCandidates.length > 0
  const explicitlyMentionedBotIds = new Set(attentionTargets
    .filter((target) => target.kind === MENTION_KIND.MENTION && target.isExplicit)
    .map((target) => target.userId))
  const wakeBotUserIds = unique(eligibleWakeCandidates.map((candidate) => candidate.botUserId))
  const pushUserIds = unique([
    ...unreadPlainUserIds,
    ...unreadMentionUserIds,
    ...mentionUserIds,
  ])

  const replyMap = new Map<string, {
    id: string
    authorId: string
    authorName: string
    content: string | null
  }>()
  if (replyTarget) {
    replyMap.set(replyTarget.id, {
      id: replyTarget.id,
      authorId: replyTarget.authorId,
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
    wakeContextPlan: {
      enabled: shouldBuildWakeContext,
      channelId: message.channelId,
      beforeSeq: message.seq,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId,
      replyTarget,
    },
    operationId: await deriveCommunityDeliveryOperationId(message.id),
    messageId: message.id,
    messageEvent,
    contentUserIds,
    unreadPlainUserIds,
    unreadMentionUserIds,
    mentionUserIds,
    wakeBotUserIds,
    wakeGateInput: {
      messageId: message.id,
      channel: {
        type: channel.type,
        name: channel.name,
        topic: channel.topic,
      },
      message: {
        text: message.content,
        type: message.type,
        broadcastMention: message.mentionType === "everyone",
        attachmentContentTypes: attachments.map((attachment) => attachment.contentType),
      },
      conversation: emptyWakeConversation(),
      candidates: eligibleWakeCandidates.map((candidate) => ({
        botUserId: candidate.botUserId,
        name: candidate.name,
        discriminator: candidate.discriminator,
        instruction: candidate.instruction,
        directlyMentioned: explicitlyMentionedBotIds.has(candidate.botUserId),
        isReplyTarget: replyTarget?.authorId === candidate.botUserId,
      })),
    },
    pushUserIds,
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

export async function planCommittedMessage(
  db: Database,
  messageId: string,
  structural: CommittedMessageStructuralOutcome = {},
): Promise<MessageDeliveryPlan> {
  const { wakeContextPlan, ...plan } = await planCommittedMessageBase(
    db,
    messageId,
    structural,
  )
  const conversation = await loadWakeConversation(db, messageId, wakeContextPlan)
  return {
    ...plan,
    wakeGateInput: { ...plan.wakeGateInput, conversation },
  }
}

async function runCommittedMessageDispatch(
  db: Database,
  messageId: string,
  structural: CommittedMessageStructuralOutcome,
  env: RuntimeEnv,
): Promise<void> {
  const startedAt = Date.now()
  const { wakeContextPlan, ...plan } = await planCommittedMessageBase(
    db,
    messageId,
    structural,
  )
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
  const pushTasks: AlookQueueTask[] = plan.pushUserIds.map((userId) => ({
    version: 1 as const,
    kind: "mobile-push" as const,
    messageId: plan.messageId,
    userId,
  }))
  const browserDelivery = sendMessageDeliveryBatch(browserBatch, plan.operationId)
  const pushDelivery = enqueueQueueTasks(pushTasks)
  const botWake = loadWakeConversation(db, messageId, wakeContextPlan)
    .then((conversation) => selectJevWakeCandidates({
      ...plan.wakeGateInput,
      conversation,
    }, env))
    .catch(() => {
      log.warn("committed_message_jev_gate_failed_open", { messageId })
      return plan.wakeGateInput.candidates
    })
    .then(async (candidates) => {
      await enqueueQueueTasks(candidates.map((candidate) => ({
        version: 1 as const,
        kind: "bot-wake" as const,
        messageId: plan.messageId,
        botUserId: candidate.botUserId,
      })))
      return candidates.length
    })
  const [browser, push, wake] = await Promise.allSettled([
    browserDelivery,
    pushDelivery,
    botWake,
  ])
  if (browser.status === "rejected") {
    log.warn("committed_message_browser_delivery_failed", {
      messageId,
      err: String(browser.reason),
    })
  }
  if (push.status === "rejected") {
    log.warn("committed_message_push_queue_delivery_failed", {
      messageId,
      err: String(push.reason),
    })
  }
  if (wake.status === "rejected") {
    log.warn("committed_message_wake_queue_delivery_failed", {
      messageId,
      err: String(wake.reason),
    })
  }
  log.info("committed_message_dispatch_complete", {
    messageId,
    contentCount: plan.contentUserIds.length,
    unreadCount: plan.unreadPlainUserIds.length + plan.unreadMentionUserIds.length,
    mentionCount: plan.mentionUserIds.length,
    wakeCount: wake.status === "fulfilled" ? wake.value : 0,
    pushCount: plan.pushUserIds.length,
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
  let env = {} as RuntimeEnv
  let executionContext: ExecutionContext | undefined
  try {
    const cloudflare = getCloudflareContext()
    env = cloudflare.env
    executionContext = cloudflare.ctx
  } catch {
    // Unit tests and non-Cloudflare callers may not expose a request context.
  }
  const work = runCommittedMessageDispatch(db, messageId, structural, env).catch((err) => {
    log.warn("committed_message_dispatch_failed", { messageId, err: String(err) })
  })
  executionContext?.waitUntil(work)
  return work
}
