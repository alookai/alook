export type BotWakeQueueTaskV1 = {
  version: 1
  kind: "bot-wake"
  messageId: string
  botUserId: string
}

export type MobilePushQueueTaskV1 = {
  version: 1
  kind: "mobile-push"
  messageId: string
  userId: string
}

export type AlookQueueTask = BotWakeQueueTaskV1 | MobilePushQueueTaskV1

export type QueueTaskRejectReason =
  | "malformed"
  | "unsupported_version"
  | "unknown_kind"

export type QueueTaskParseResult =
  | { ok: true; source: "legacy" | "v1"; task: AlookQueueTask }
  | { ok: false; reason: QueueTaskRejectReason }

export type QueueTaskBatchParseResult =
  | { ok: true; tasks: AlookQueueTask[] }
  | { ok: false; reason: QueueTaskRejectReason; itemIndex: number | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every((key) => hasOwn(value, key))
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function parseQueueTask(value: unknown): QueueTaskParseResult {
  if (!isRecord(value)) return { ok: false, reason: "malformed" }

  const hasDiscriminator = hasOwn(value, "version") || hasOwn(value, "kind")
  if (!hasDiscriminator) {
    if (
      !hasExactKeys(value, ["messageId", "botUserId"])
      || !isNonEmptyId(value.messageId)
      || !isNonEmptyId(value.botUserId)
    ) {
      return { ok: false, reason: "malformed" }
    }

    return {
      ok: true,
      source: "legacy",
      task: {
        version: 1,
        kind: "bot-wake",
        messageId: value.messageId,
        botUserId: value.botUserId,
      },
    }
  }

  if (!hasOwn(value, "version") || typeof value.version !== "number") {
    return { ok: false, reason: "malformed" }
  }
  if (value.version !== 1) return { ok: false, reason: "unsupported_version" }
  if (!hasOwn(value, "kind") || typeof value.kind !== "string") {
    return { ok: false, reason: "malformed" }
  }

  if (value.kind === "bot-wake") {
    if (
      !hasExactKeys(value, ["version", "kind", "messageId", "botUserId"])
      || !isNonEmptyId(value.messageId)
      || !isNonEmptyId(value.botUserId)
    ) {
      return { ok: false, reason: "malformed" }
    }

    return {
      ok: true,
      source: "v1",
      task: {
        version: 1,
        kind: "bot-wake",
        messageId: value.messageId,
        botUserId: value.botUserId,
      },
    }
  }

  if (value.kind === "mobile-push") {
    if (
      !hasExactKeys(value, ["version", "kind", "messageId", "userId"])
      || !isNonEmptyId(value.messageId)
      || !isNonEmptyId(value.userId)
    ) {
      return { ok: false, reason: "malformed" }
    }
    return {
      ok: true,
      source: "v1",
      task: {
        version: 1,
        kind: "mobile-push",
        messageId: value.messageId,
        userId: value.userId,
      },
    }
  }

  return { ok: false, reason: "unknown_kind" }
}

export function parseQueueTaskBatch(value: unknown): QueueTaskBatchParseResult {
  if (!Array.isArray(value)) return { ok: false, reason: "malformed", itemIndex: null }

  const tasks: AlookQueueTask[] = []
  for (let itemIndex = 0; itemIndex < value.length; itemIndex++) {
    const result = parseQueueTask(value[itemIndex])
    if (!result.ok) return { ok: false, reason: result.reason, itemIndex }
    tasks.push(result.task)
  }

  return { ok: true, tasks }
}
