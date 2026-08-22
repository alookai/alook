import {
  COMMUNITY_DELIVERY_OPERATION_ID_HEADER,
  MESSAGE_DELIVERY_BODY_MAX_BYTES,
  WS_EVENTS,
  deriveCommunityDeliveryOperationId,
  isCommunityDeliveryOperationId,
  parseMessageDeliveryBatch,
  prepareCommunityDeliveryEvents,
  type CommunityDeliveryOperationId,
  type CommunityWsEvent,
} from "@alook/shared"
import { readBoundedJsonRequest } from "../community-browser-event-ingress"
import { isExactCommunityDeliveryReceipt } from "../community-delivery-receipt"
import { createInternalCommunityUserBundleRequest } from "../internal-user-broadcast"
import type { RouterContext } from "../router-context"
import { settleInBatches } from "../settle-in-batches"

const targetBatchSize = 40

type TargetResult =
  | { ok: true }
  | { ok: false; kind: "throw" | "non-ok" | "invalid-json" | "invalid-receipt" }

function addEvent(
  bundles: Map<string, CommunityWsEvent[]>,
  userId: string,
  event: CommunityWsEvent,
): void {
  const events = bundles.get(userId) ?? []
  events.push(event)
  bundles.set(userId, events)
}

async function deliverTarget(
  env: Env,
  userId: string,
  events: CommunityWsEvent[],
  operationId: CommunityDeliveryOperationId,
): Promise<TargetResult> {
  const prepared = await prepareCommunityDeliveryEvents(events)
  if (!prepared.ok) return { ok: false, kind: "invalid-receipt" }
  try {
    const id = env.WS_DO.idFromName(`user:${userId}`)
    const response = await env.WS_DO.get(id).fetch(
      createInternalCommunityUserBundleRequest(
        userId,
        operationId,
        prepared.prepared.digest,
        prepared.prepared.envelopes,
      ),
    )
    if (!response.ok) return { ok: false, kind: "non-ok" }
    let receipt: unknown
    try {
      receipt = await response.json()
    } catch {
      return { ok: false, kind: "invalid-json" }
    }
    if (!isExactCommunityDeliveryReceipt(receipt, {
      operationId,
      operationDigest: prepared.prepared.digest,
      eventCount: events.length,
    })) {
      return { ok: false, kind: "invalid-receipt" }
    }
    return { ok: true }
  } catch {
    return { ok: false, kind: "throw" }
  }
}

export async function handleMessageDelivery(
  { request, env, url, traceId, log }: RouterContext,
): Promise<Response | null> {
  if (url.pathname !== "/broadcast/community/message-delivery" || request.method !== "POST") {
    return null
  }
  const parsedBody = await readBoundedJsonRequest(request, MESSAGE_DELIVERY_BODY_MAX_BYTES)
  if (!parsedBody.ok) {
    return Response.json({ error: "invalid message delivery", reason: parsedBody.reason }, { status: 400 })
  }
  const parsed = parseMessageDeliveryBatch(parsedBody.value)
  if (!parsed.ok) {
    return Response.json({ error: "invalid message delivery", reason: parsed.reason }, { status: 400 })
  }
  const batch = parsed.batch
  let derivedOperationId: CommunityDeliveryOperationId
  try {
    derivedOperationId = await deriveCommunityDeliveryOperationId(batch.messageId)
  } catch {
    return Response.json({ error: "invalid message delivery", reason: "invalid-message-id" }, { status: 400 })
  }
  const headerOperationId = request.headers.get(COMMUNITY_DELIVERY_OPERATION_ID_HEADER)?.trim()
  if (
    !isCommunityDeliveryOperationId(headerOperationId)
    || headerOperationId !== derivedOperationId
  ) {
    return Response.json({ error: "invalid message delivery", reason: "operation-id-mismatch" }, { status: 400 })
  }
  const operationId = headerOperationId
  const bundles = new Map<string, CommunityWsEvent[]>()

  for (const userId of batch.contentUserIds) addEvent(bundles, userId, batch.messageEvent)
  for (const userId of batch.unreadPlainUserIds) {
    addEvent(bundles, userId, {
      type: WS_EVENTS.UNREAD_BUMP,
      userId,
      channelId: batch.messageEvent.channelId,
      ...(batch.messageEvent.serverId ? { serverId: batch.messageEvent.serverId } : {}),
      ...(batch.messageEvent.serverId
        ? { railChannelId: batch.messageEvent.parentChannelId ?? batch.messageEvent.channelId }
        : {}),
      isMention: false,
    })
  }
  for (const userId of batch.unreadMentionUserIds) {
    addEvent(bundles, userId, {
      type: WS_EVENTS.UNREAD_BUMP,
      userId,
      channelId: batch.messageEvent.channelId,
      ...(batch.messageEvent.serverId ? { serverId: batch.messageEvent.serverId } : {}),
      ...(batch.messageEvent.serverId
        ? { railChannelId: batch.messageEvent.parentChannelId ?? batch.messageEvent.channelId }
        : {}),
      isMention: true,
    })
  }
  for (const userId of batch.mentionUserIds) {
    addEvent(bundles, userId, {
      type: WS_EVENTS.MENTION_CREATE,
      userId,
      messageId: batch.messageId,
      channelId: batch.messageEvent.channelId,
      authorName: batch.messageEvent.message.authorName,
    })
  }
  if (batch.memberAdded) {
    addEvent(bundles, batch.memberAdded.userId, {
      type: WS_EVENTS.CHANNEL_MEMBER_ADD,
      ...batch.memberAdded,
    })
  }
  if (batch.parentProjection && batch.parentProjectionUserIds) {
    for (const userId of batch.parentProjectionUserIds) {
      addEvent(bundles, userId, batch.parentProjection)
    }
  }

  const entries = [...bundles.entries()]
  const startedAt = Date.now()
  const results = await settleInBatches(
    entries,
    ([userId, events]) => deliverTarget(env, userId, events, operationId),
    targetBatchSize,
  )
  const failedUserIds: string[] = []
  const failureCounts = { throw: 0, "non-ok": 0, "invalid-json": 0, "invalid-receipt": 0 }
  for (const [index, result] of results.entries()) {
    const target = entries[index]!
    if (result.status === "rejected") {
      failedUserIds.push(target[0])
      failureCounts.throw += 1
    } else if (!result.value.ok) {
      failedUserIds.push(target[0])
      failureCounts[result.value.kind] += 1
    }
  }
  log.info("message_delivery_complete", {
    traceId,
    messageId: batch.messageId,
    operationId,
    targetCount: entries.length,
    failedCount: failedUserIds.length,
    failureCounts,
    durationMs: Date.now() - startedAt,
  })
  return Response.json(
    { failedUserIds },
    { status: failedUserIds.length > 0 ? 207 : 200 },
  )
}
