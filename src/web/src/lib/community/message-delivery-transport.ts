import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  COMMUNITY_DELIVERY_OPERATION_ID_HEADER,
  DEV_WS_DO_URL,
  MESSAGE_DELIVERY_MAX_USERS,
  createLogger,
  deriveCommunityDeliveryOperationId,
  isValidCommunityUserTarget,
  parseStrictFailedSubset,
  serializeMessageDeliveryBatch,
  type MessageDeliveryBatch,
  type CommunityDeliveryOperationId,
} from "@alook/shared"
import { fetchViaBindingOrDevFallback } from "../dev-binding-fetch"
import { broadcastToUsers } from "../broadcast"

const log = createLogger({ service: "message-delivery-transport" })
const maxAttempts = 3
const maxActiveChunks = 3

function allTargetUserIds(batch: MessageDeliveryBatch): string[] {
  return [...new Set([
    ...batch.contentUserIds,
    ...batch.unreadPlainUserIds,
    ...batch.unreadMentionUserIds,
    ...batch.mentionUserIds,
    ...(batch.memberAdded ? [batch.memberAdded.userId] : []),
    ...(batch.parentProjectionUserIds ?? []),
  ])]
}

function selectTargets(batch: MessageDeliveryBatch, selected: ReadonlySet<string>): MessageDeliveryBatch {
  const keep = (ids: readonly string[]) => ids.filter((id) => selected.has(id))
  const parentProjectionUserIds = keep(batch.parentProjectionUserIds ?? [])
  return {
    messageId: batch.messageId,
    messageEvent: batch.messageEvent,
    contentUserIds: keep(batch.contentUserIds),
    unreadPlainUserIds: keep(batch.unreadPlainUserIds),
    unreadMentionUserIds: keep(batch.unreadMentionUserIds),
    mentionUserIds: keep(batch.mentionUserIds),
    ...(batch.memberAdded && selected.has(batch.memberAdded.userId)
      ? { memberAdded: batch.memberAdded }
      : {}),
    ...(batch.parentProjection && parentProjectionUserIds.length > 0
      ? { parentProjection: batch.parentProjection, parentProjectionUserIds }
      : {}),
  }
}

function parseFailedUserIds(value: unknown, requested: readonly string[]): string[] | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, "failedUserIds")
  ) return null
  return parseStrictFailedSubset(
    (value as { failedUserIds?: unknown }).failedUserIds,
    requested,
    {
      isTarget: isValidCommunityUserTarget,
      key: (target) => target,
    },
  )
}

async function sendAttempt(
  env: Env,
  batch: MessageDeliveryBatch,
  operationId: CommunityDeliveryOperationId,
): Promise<string[]> {
  const requested = allTargetUserIds(batch)
  const response = await fetchViaBindingOrDevFallback(
    env.WS_DO_WORKER,
    env.DEV_WS_DO_URL || DEV_WS_DO_URL,
    "/broadcast/community/message-delivery",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [COMMUNITY_DELIVERY_OPERATION_ID_HEADER]: operationId,
      },
      body: serializeMessageDeliveryBatch(batch),
    },
    { logPrefix: "message_delivery", log, label: batch.messageId },
  )
  if (response.status === 404 || response.status === 405) {
    log.warn("message_delivery_legacy_compat", {
      messageId: batch.messageId,
      status: response.status,
      targetCount: requested.length,
      contentCount: batch.contentUserIds.length,
      unreadCount: batch.unreadPlainUserIds.length + batch.unreadMentionUserIds.length,
      mentionCount: batch.mentionUserIds.length,
      memberCount: batch.memberAdded ? 1 : 0,
      parentCount: batch.parentProjectionUserIds?.length ?? 0,
    })
    await deliverWithLegacyCommunityBroadcast(batch)
    return []
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error("message delivery: invalid response")
  }
  if (response.status === 200) {
    if (
      typeof body !== "object"
      || body === null
      || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !Array.isArray((body as { failedUserIds?: unknown }).failedUserIds)
      || (body as { failedUserIds: unknown[] }).failedUserIds.length !== 0
    ) throw new Error("message delivery: invalid success response")
    return []
  }
  if (response.status !== 207) {
    throw new Error(`message delivery: ws-do responded ${response.status}`)
  }
  const failed = parseFailedUserIds(body, requested)
  if (!failed) throw new Error("message delivery: invalid partial response")
  return failed
}

async function deliverWithLegacyCommunityBroadcast(batch: MessageDeliveryBatch): Promise<void> {
  const message = batch.messageEvent
  if (batch.contentUserIds.length > 0) {
    await broadcastToUsers(batch.contentUserIds, message)
  }
  await settleLegacyTargets(batch.unreadPlainUserIds, (userId) =>
    broadcastToUsers([userId], {
      type: "community:unread.bump",
      userId,
      channelId: message.channelId,
      ...(message.serverId ? { serverId: message.serverId } : {}),
      ...(message.serverId
        ? { railChannelId: message.parentChannelId ?? message.channelId }
        : {}),
      isMention: false,
    }),
  )
  await settleLegacyTargets(batch.unreadMentionUserIds, (userId) =>
    broadcastToUsers([userId], {
      type: "community:unread.bump",
      userId,
      channelId: message.channelId,
      ...(message.serverId ? { serverId: message.serverId } : {}),
      ...(message.serverId
        ? { railChannelId: message.parentChannelId ?? message.channelId }
        : {}),
      isMention: true,
    }),
  )
  await settleLegacyTargets(batch.mentionUserIds, (userId) =>
    broadcastToUsers([userId], {
      type: "community:mention.create",
      userId,
      messageId: batch.messageId,
      channelId: message.channelId,
      authorName: message.message.authorName,
    }),
  )
  if (batch.memberAdded) {
    await broadcastToUsers([batch.memberAdded.userId], {
      type: "community:channel.member_add",
      ...batch.memberAdded,
    })
  }
  if (batch.parentProjection && batch.parentProjectionUserIds?.length) {
    await broadcastToUsers(batch.parentProjectionUserIds, batch.parentProjection)
  }
}

async function settleLegacyTargets(
  userIds: readonly string[],
  send: (userId: string) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(maxActiveChunks, userIds.length) }, async () => {
    while (next < userIds.length) await send(userIds[next++]!)
  })
  await Promise.all(workers)
}

async function sendChunk(
  env: Env,
  initial: MessageDeliveryBatch,
  operationId: CommunityDeliveryOperationId,
): Promise<void> {
  let pending = initial
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now()
    const failed = await sendAttempt(env, pending, operationId)
    log.info("message_delivery_attempt_complete", {
      messageId: initial.messageId,
      attempt,
      targetCount: allTargetUserIds(pending).length,
      failedCount: failed.length,
      durationMs: Date.now() - startedAt,
    })
    if (failed.length === 0) return
    if (attempt === maxAttempts) {
      throw new Error(`message delivery exhausted for ${failed.length} user(s)`)
    }
    pending = selectTargets(initial, new Set(failed))
  }
}

async function settleChunks(
  env: Env,
  chunks: MessageDeliveryBatch[],
  operationId: CommunityDeliveryOperationId,
): Promise<void> {
  let next = 0
  const results: PromiseSettledResult<void>[] = new Array(chunks.length)
  const workers = Array.from({ length: Math.min(maxActiveChunks, chunks.length) }, async () => {
    while (next < chunks.length) {
      const index = next++
      try {
        await sendChunk(env, chunks[index]!, operationId)
        results[index] = { status: "fulfilled", value: undefined }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  })
  await Promise.all(workers)
  const failures = results.filter((result) => result.status === "rejected")
  if (failures.length > 0) {
    throw new Error(`message delivery failed for ${failures.length} chunk(s)`)
  }
}

export async function sendMessageDeliveryBatch(
  batch: MessageDeliveryBatch,
  plannedOperationId?: CommunityDeliveryOperationId,
): Promise<void> {
  const derivedOperationId = await deriveCommunityDeliveryOperationId(batch.messageId)
  if (plannedOperationId !== undefined && plannedOperationId !== derivedOperationId) {
    throw new Error("message delivery: operation ID does not match message")
  }
  const operationId = plannedOperationId ?? derivedOperationId
  const { env } = getCloudflareContext()
  const targets = allTargetUserIds(batch)
  const chunks: MessageDeliveryBatch[] = []
  let index = 0
  while (index < targets.length) {
    const maxEnd = Math.min(index + MESSAGE_DELIVERY_MAX_USERS, targets.length)
    let low = index + 1
    let high = maxEnd
    let accepted: MessageDeliveryBatch | null = null
    let acceptedEnd = index
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = selectTargets(batch, new Set(targets.slice(index, middle)))
      try {
        serializeMessageDeliveryBatch(candidate)
        accepted = candidate
        acceptedEnd = middle
        low = middle + 1
      } catch {
        high = middle - 1
      }
    }
    if (!accepted) {
      const single = selectTargets(batch, new Set([targets[index]!]))
      serializeMessageDeliveryBatch(single)
      throw new Error("message delivery: unable to form chunk")
    }
    chunks.push(accepted)
    index = acceptedEnd
  }
  await settleChunks(env as Env, chunks, operationId)
}
