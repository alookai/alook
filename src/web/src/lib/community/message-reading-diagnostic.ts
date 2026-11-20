export const READING_DIAGNOSTIC_STAGES = [
  "collector.start", "surface.bind", "surface.ready", "reading.commit", "reading.content", "reading.input", "reading.reconcile", "reading.report",
  "reading.parent", "reading.parent-result", "controller.bind", "pagination.gate", "pagination.attempt",
  "pagination.before-load", "pagination.load", "pagination.settle", "anchor.before-load", "anchor.receive", "anchor.complete",
  "fetch.gate", "fetch.wait", "fetch.start", "fetch.complete", "transport.start", "transport.receive", "transport.publish",
  "observer.request", "observer.headers", "observer.json-start", "observer.json", "observer.schema-start", "observer.schema",
  "observer.finished-start", "observer.finished", "observer.receipt-push",
  "observer.failed", "observer.cleanup", "phase.start", "document.navigation",
] as const

export const READING_DIAGNOSTIC_ENUMS = [
  "manual", "automatic", "older", "newer", "newest", "since", "anchor", "start", "end", "idle", "pending", "fetching", "settling",
  "ready", "empty", "error", "success", "retired", "missing", "cancelled", "published", "stale", "aborted", "unknown",
  "accepted", "rejected", "unchanged", "no-reading", "invalid-owner", "data-pending", "correction", "invalid-offset",
  "same-geometry", "no-message", "no-query-data", "no-page", "no-next-page", "deduplicated", "near-edge", "callback",
  "initial", "target", "present", "layout", "validation", "baseline", "native",
] as const

export const READING_DIAGNOSTIC_VALUE_KEYS = [
  "active", "enabled", "visible", "ownerActive", "ownerCurrent", "queryPresent", "dataPresent", "windowReady", "sameQuery",
  "samePage", "pageCount", "messageCount", "missingCanonical", "projectionFailed", "dataState", "pending", "positionKind",
  "readReady", "rowsCommitted", "manualEpoch", "epoch", "sameRoot", "sameEpoch", "hasReader", "nativePresent", "readingPresent",
  "paginationPhase", "semanticIntent", "projectionAnchor", "viewportCorrection", "sameGeometry", "sameWindow", "sameItems",
  "offsetAligned", "withinBounds", "reason", "source", "direction", "count", "rowCount", "boundaryPresent", "boundaryIndex",
  "hasMore", "hasMoreAtStart", "isFetching", "isError", "retry", "loadWhenReady", "preloadWithinViewport", "attemptPresent",
  "attemptPending", "attemptLegacy", "attemptCount", "attemptWindowCurrent", "attemptKeyCurrent", "nearEdge", "atStart",
  "requestPresent", "accepted", "result", "callbackPresent", "phase", "pagePending", "initialError", "neighborhoodPresent",
  "olderEligible", "newerEligible", "fetching", "fetchingOlder", "fetchingNewer", "olderError", "newerError", "readPositionReady",
  "paginationEnabled", "paginationRequestPending", "status", "receiptCount", "requestCount", "finishedError", "failure",
  "operationCount", "navigationCount", "schemaOk", "restoringBody",
] as const

export const READING_DIAGNOSTIC_IDENTITY_KEYS = [
  "channel", "message", "pageKey", "queryKey", "cursor", "nextOlderCursor", "nextNewerCursor", "pageParam", "previousPageKey", "reportedMessage", "boundaryKey",
] as const

export const READING_DIAGNOSTIC_REFERENCE_KEYS = [
  "reader", "owner", "present", "query", "window", "committedOwner", "root", "virtualizer", "loader", "beforeLoad", "requestKey",
  "attempt", "request", "receipt", "client", "callback", "items", "rows", "reading", "nodeRequest",
] as const

export type ReadingDiagnosticStage = typeof READING_DIAGNOSTIC_STAGES[number]
type ReadingDiagnosticValue = number | boolean | null | typeof READING_DIAGNOSTIC_ENUMS[number]
export type ReadingDiagnosticFields = {
  values?: Partial<Record<typeof READING_DIAGNOSTIC_VALUE_KEYS[number], ReadingDiagnosticValue | undefined>>
  identities?: Partial<Record<typeof READING_DIAGNOSTIC_IDENTITY_KEYS[number], string | null | undefined>>
  refs?: Partial<Record<typeof READING_DIAGNOSTIC_REFERENCE_KEYS[number], object | null | undefined>>
}

export type ReadingDiagnosticRecord = {
  sequence: number
  stage: ReadingDiagnosticStage
  pageNow: number
  epochMs: number
  timeOrigin: number
  documentHash: string | null
  values: Record<string, ReadingDiagnosticValue>
  hashes: Record<string, string | null>
  refs: Record<string, string | null>
  hashFailure: boolean
}

export type ReadingDiagnosticSnapshot = {
  records: ReadingDiagnosticRecord[]
  active: boolean
  pending: number
  invoked: number
  dropped: number
  rejected: number
  hashErrors: number
  sourceErrors: number
  afterStop: number
}

type ReadingDiagnosticSink = {
  record: (stage: ReadingDiagnosticStage, fields: ReadingDiagnosticFields) => void
  failure: () => void
  snapshot: (stop?: boolean) => Promise<ReadingDiagnosticSnapshot>
}

declare global {
  interface Window {
    __alookMessageReadingDiagnostic?: ReadingDiagnosticSink
  }
}

export function observeMessageReading(stage: ReadingDiagnosticStage, fields: () => ReadingDiagnosticFields): void {
  if (typeof window === "undefined") return
  const sink = window.__alookMessageReadingDiagnostic
  if (!sink) return
  try {
    sink.record(stage, fields())
  } catch {
    try { sink.failure() } catch {}
  }
}
