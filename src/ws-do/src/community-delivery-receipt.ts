import {
  isCommunityDeliveryDigest,
  isCommunityDeliveryOperationId,
} from "@alook/shared"

type CommunityDeliveryOutcome =
  | "enqueued"
  | "alreadyEnqueued"
  | "preflightFailed"
  | "notAttempted"
  | "partial"
  | "failed"

export type CommunityDeliverySocketResult = {
  socketIndex: number
  outcome: CommunityDeliveryOutcome
  frameCount: number
  persistedNextFrameIndex: number
  ambiguousClosed: boolean
}

export type CommunityDeliveryReceipt = {
  status: "complete" | "incomplete"
  validated: true
  operationId: string
  operationDigest: string
  eventCount: number
  matched: number
  attempted: number
  enqueued: number
  alreadyEnqueued: number
  preflightFailed: number
  notAttempted: number
  partial: number
  failed: number
  ambiguousClosed: number
  results: CommunityDeliverySocketResult[]
}

const RECEIPT_KEYS = [
  "status",
  "validated",
  "operationId",
  "operationDigest",
  "eventCount",
  "matched",
  "attempted",
  "enqueued",
  "alreadyEnqueued",
  "preflightFailed",
  "notAttempted",
  "partial",
  "failed",
  "ambiguousClosed",
  "results",
] as const

const RESULT_KEYS = [
  "socketIndex",
  "outcome",
  "frameCount",
  "persistedNextFrameIndex",
  "ambiguousClosed",
] as const

const OUTCOMES: ReadonlySet<string> = new Set<CommunityDeliveryOutcome>([
  "enqueued",
  "alreadyEnqueued",
  "preflightFailed",
  "notAttempted",
  "partial",
  "failed",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function createCommunityDeliveryReceipt(input: {
  status: "complete" | "incomplete"
  operationId: string
  operationDigest: string
  eventCount: number
  results: CommunityDeliverySocketResult[]
}): CommunityDeliveryReceipt {
  const count = (outcome: CommunityDeliveryOutcome) =>
    input.results.filter((result) => result.outcome === outcome).length
  const partial = count("partial")
  const failed = count("failed")
  return {
    status: input.status,
    validated: true,
    operationId: input.operationId,
    operationDigest: input.operationDigest,
    eventCount: input.eventCount,
    matched: input.results.length,
    attempted: count("enqueued") + partial + failed,
    enqueued: count("enqueued"),
    alreadyEnqueued: count("alreadyEnqueued"),
    preflightFailed: count("preflightFailed"),
    notAttempted: count("notAttempted"),
    partial,
    failed,
    ambiguousClosed: input.results.filter((result) => result.ambiguousClosed).length,
    results: input.results,
  }
}

export function isExactCommunityDeliveryReceipt(
  value: unknown,
  expected: { operationId: string; operationDigest: string; eventCount: number },
): value is CommunityDeliveryReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false
  if (
    value.status !== "complete"
    || value.validated !== true
    || value.operationId !== expected.operationId
    || value.operationDigest !== expected.operationDigest
    || value.eventCount !== expected.eventCount
    || !isCommunityDeliveryOperationId(value.operationId)
    || !isCommunityDeliveryDigest(value.operationDigest)
  ) return false
  const numericKeys = [
    "matched",
    "attempted",
    "enqueued",
    "alreadyEnqueued",
    "preflightFailed",
    "notAttempted",
    "partial",
    "failed",
    "ambiguousClosed",
  ] as const
  if (numericKeys.some((key) => !isNonNegativeInteger(value[key]))) return false
  if (!Array.isArray(value.results) || value.results.length !== value.matched) return false

  const projected = {
    enqueued: 0,
    alreadyEnqueued: 0,
    preflightFailed: 0,
    notAttempted: 0,
    partial: 0,
    failed: 0,
    ambiguousClosed: 0,
  }
  for (let index = 0; index < value.results.length; index += 1) {
    const result = value.results[index]
    if (!isRecord(result) || !hasExactKeys(result, RESULT_KEYS)) return false
    if (
      result.socketIndex !== index
      || typeof result.outcome !== "string"
      || !OUTCOMES.has(result.outcome)
      || !isNonNegativeInteger(result.frameCount)
      || result.frameCount !== 1
      || !isNonNegativeInteger(result.persistedNextFrameIndex)
      || result.persistedNextFrameIndex > result.frameCount
      || typeof result.ambiguousClosed !== "boolean"
    ) return false
    if (result.outcome === "partial" && (
      result.persistedNextFrameIndex <= 0
      || result.persistedNextFrameIndex >= result.frameCount
    )) return false
    if (
      (result.outcome === "enqueued" || result.outcome === "alreadyEnqueued")
      && result.persistedNextFrameIndex !== result.frameCount
    ) return false
    if (
      result.ambiguousClosed
      && result.outcome !== "partial"
      && result.outcome !== "failed"
    ) return false
    projected[result.outcome as CommunityDeliveryOutcome] += 1
    if (result.ambiguousClosed) projected.ambiguousClosed += 1
  }
  if (
    projected.enqueued !== value.enqueued
    || projected.alreadyEnqueued !== value.alreadyEnqueued
    || projected.preflightFailed !== value.preflightFailed
    || projected.notAttempted !== value.notAttempted
    || projected.partial !== value.partial
    || projected.failed !== value.failed
    || projected.ambiguousClosed !== value.ambiguousClosed
  ) return false
  return value.matched === value.enqueued
      + value.alreadyEnqueued
      + value.preflightFailed
      + value.notAttempted
      + value.partial
      + value.failed
    && value.attempted === value.enqueued + value.partial + value.failed
    && value.ambiguousClosed <= value.partial + value.failed
    && value.preflightFailed === 0
    && value.notAttempted === 0
    && value.partial === 0
    && value.failed === 0
    && value.ambiguousClosed === 0
}
