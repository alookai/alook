import {
  isCommunityDeliveryDigest,
  isCommunityDeliveryOperationId,
} from "@alook/shared"

export type CommunityDeliveryMode = "batch" | "legacy"
type CommunityDeliveryOutcome =
  | "enqueued"
  | "alreadyEnqueued"
  | "preflightFailed"
  | "notAttempted"
  | "partial"
  | "failed"

export type CommunityDeliverySocketResult = {
  socketIndex: number
  mode: CommunityDeliveryMode
  outcome: CommunityDeliveryOutcome
  frameCount: number
  persistedNextFrameIndex: number
  ambiguousClosed: boolean
}

export type CommunityDeliveryReceipt = {
  contractVersion: 1
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
  modes: { batch: number; legacy: number }
  results: CommunityDeliverySocketResult[]
}

const RECEIPT_KEYS = [
  "contractVersion",
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
  "modes",
  "results",
] as const

const RESULT_KEYS = [
  "socketIndex",
  "mode",
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
    contractVersion: 1,
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
    modes: {
      batch: input.results.filter((result) => result.mode === "batch").length,
      legacy: input.results.filter((result) => result.mode === "legacy").length,
    },
    results: input.results,
  }
}

export function isExactCommunityDeliveryReceipt(
  value: unknown,
  expected: { operationId: string; operationDigest: string; eventCount: number },
): value is CommunityDeliveryReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) return false
  if (
    value.contractVersion !== 1
    || value.status !== "complete"
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
  if (!isRecord(value.modes) || !hasExactKeys(value.modes, ["batch", "legacy"])) return false
  if (!isNonNegativeInteger(value.modes.batch) || !isNonNegativeInteger(value.modes.legacy)) return false
  if (!Array.isArray(value.results) || value.results.length !== value.matched) return false

  const projected = {
    enqueued: 0,
    alreadyEnqueued: 0,
    preflightFailed: 0,
    notAttempted: 0,
    partial: 0,
    failed: 0,
    ambiguousClosed: 0,
    batch: 0,
    legacy: 0,
  }
  for (let index = 0; index < value.results.length; index += 1) {
    const result = value.results[index]
    if (!isRecord(result) || !hasExactKeys(result, RESULT_KEYS)) return false
    if (
      result.socketIndex !== index
      || (result.mode !== "batch" && result.mode !== "legacy")
      || typeof result.outcome !== "string"
      || !OUTCOMES.has(result.outcome)
      || !isNonNegativeInteger(result.frameCount)
      || result.frameCount < 1
      || result.frameCount !== (result.mode === "batch" ? 1 : expected.eventCount)
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
    projected[result.mode] += 1
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
    || projected.batch !== value.modes.batch
    || projected.legacy !== value.modes.legacy
  ) return false
  return value.matched === value.enqueued
      + value.alreadyEnqueued
      + value.preflightFailed
      + value.notAttempted
      + value.partial
      + value.failed
    && value.attempted === value.enqueued + value.partial + value.failed
    && value.modes.batch + value.modes.legacy === value.matched
    && value.ambiguousClosed <= value.partial + value.failed
    && value.preflightFailed === 0
    && value.notAttempted === 0
    && value.partial === 0
    && value.failed === 0
    && value.ambiguousClosed === 0
}
