import { getCloudflareContext } from "@opennextjs/cloudflare"
import {
  BUSINESS_SCHEMA_VERSION,
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

const log = createLogger({ service: "message-delivery-transport" })
const maxAttempts = 3
const maxActiveChunks = 3

class RetryableMessageDeliveryError extends Error {}

function allTargetUserIds(batch: MessageDeliveryBatch): string[] {
  return [...new Set([
    ...batch.contentUserIds,
    ...batch.unreadPlainUserIds,
    ...batch.unreadMentionUserIds,
    ...batch.mentionUserIds,
    ...(batch.parentProjectionUserIds ?? []),
  ])]
}

function selectTargets(batch: MessageDeliveryBatch, selected: ReadonlySet<string>): MessageDeliveryBatch {
  const keep = (ids: readonly string[]) => ids.filter((id) => selected.has(id))
  const parentProjectionUserIds = keep(batch.parentProjectionUserIds ?? [])
  return {
    communityContract: batch.communityContract,
    messageId: batch.messageId,
    messageEvent: batch.messageEvent,
    contentUserIds: keep(batch.contentUserIds),
    unreadPlainUserIds: keep(batch.unreadPlainUserIds),
    unreadMentionUserIds: keep(batch.unreadMentionUserIds),
    mentionUserIds: keep(batch.mentionUserIds),
    ...(batch.joinedParticipantUserIds ? { joinedParticipantUserIds: keep(batch.joinedParticipantUserIds), rosterRefreshUserId: batch.rosterRefreshUserId } : {}),
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
  serializedBody?: string,
): Promise<string[]> {
  const requested = allTargetUserIds(batch)
  let response: Response
  try {
    response = await fetchViaBindingOrDevFallback(
      env.WS_DO_WORKER,
      env.DEV_WS_DO_URL || DEV_WS_DO_URL,
      "/broadcast/community/message-delivery",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [COMMUNITY_DELIVERY_OPERATION_ID_HEADER]: operationId,
        },
        body: serializedBody ?? serializeMessageDeliveryBatch(batch),
      },
      { logPrefix: "message_delivery", log, label: batch.messageId },
    )
  } catch (error) {
    throw new RetryableMessageDeliveryError("message delivery: transport failed", { cause: error })
  }
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    throw new RetryableMessageDeliveryError(`message delivery: ws-do responded ${response.status}`)
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

type PreparedDeliveryChunk = {
  batch: MessageDeliveryBatch
  serializedBody: string
}

async function sendChunk(
  env: Env,
  initial: PreparedDeliveryChunk,
  operationId: CommunityDeliveryOperationId,
): Promise<void> {
  let pending = initial.batch
  let pendingBody: string | undefined = initial.serializedBody
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now()
    let failed: string[]
    try {
      failed = await sendAttempt(env, pending, operationId, pendingBody)
    } catch (error) {
      if (!(error instanceof RetryableMessageDeliveryError) || attempt === maxAttempts) throw error
      continue
    }
    const attemptSummary = {
      messageId: initial.batch.messageId,
      attempt,
      targetCount: allTargetUserIds(pending).length,
      failedCount: failed.length,
      durationMs: Date.now() - startedAt,
    }
    if (failed.length > 0) {
      log.warn("message_delivery_attempt_complete", attemptSummary)
    } else {
      log.debug("message_delivery_attempt_complete", attemptSummary)
    }
    if (failed.length === 0) return
    if (attempt === maxAttempts) {
      throw new Error(`message delivery exhausted for ${failed.length} user(s)`)
    }
    pending = selectTargets(initial.batch, new Set(failed))
    pendingBody = undefined
  }
}

async function settleChunks(
  env: Env,
  chunks: PreparedDeliveryChunk[],
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
  original: MessageDeliveryBatch,
  plannedOperationId?: CommunityDeliveryOperationId,
): Promise<void> {
  const derivedOperationId = await deriveCommunityDeliveryOperationId(original.messageId)
  if (plannedOperationId !== undefined && plannedOperationId !== derivedOperationId) {
    throw new Error("message delivery: operation ID does not match message")
  }
  const operationId = plannedOperationId ?? derivedOperationId
  const { env } = getCloudflareContext()
  if (original.communityContract !== BUSINESS_SCHEMA_VERSION) throw new Error("Community delivery protocol mismatch")
  const batch = original
  const targets = allTargetUserIds(batch)
  const chunks: PreparedDeliveryChunk[] = []
  let index = 0
  while (index < targets.length) {
    const maxEnd = Math.min(index + MESSAGE_DELIVERY_MAX_USERS, targets.length)
    let accepted: PreparedDeliveryChunk | null = null
    let acceptedEnd = index
    const fullCandidate = selectTargets(batch, new Set(targets.slice(index, maxEnd)))
    try {
      accepted = {
        batch: fullCandidate,
        serializedBody: serializeMessageDeliveryBatch(fullCandidate),
      }
      acceptedEnd = maxEnd
    } catch {
      let low = index + 1
      let high = maxEnd - 1
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = selectTargets(batch, new Set(targets.slice(index, middle)))
        try {
          accepted = {
            batch: candidate,
            serializedBody: serializeMessageDeliveryBatch(candidate),
          }
          acceptedEnd = middle
          low = middle + 1
        } catch {
          high = middle - 1
        }
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
