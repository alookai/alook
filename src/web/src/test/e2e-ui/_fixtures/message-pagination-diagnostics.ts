import type { Page, TestInfo } from "@playwright/test"
import type { PaginationDiagnosticBridge, PaginationDiagnosticFields, PaginationDiagnosticSource } from "@/lib/community/message-pagination-diagnostics"

export function installMessagePaginationDiagnostics() {
  const limit = 1024
  const sources = new Set<PaginationDiagnosticSource>()
  const identities = new WeakMap<object, number>()
  let identity = 0, dropped = 0, sourceReadErrors = 0, sequence = 0
  let phase = "setup"
  const counts: Record<string, number> = {}
  const records: PaginationDiagnosticFields[] = []
  const firstRejections: PaginationDiagnosticFields[] = []
  const first = new Set<string>()
  const observer: PaginationDiagnosticBridge = {
    sources, observerFailures: 0,
    id: value => {
      let valueId = identities.get(value)
      if (valueId === undefined) { valueId = ++identity; identities.set(value, valueId) }
      return valueId
    },
    capture: (scope, event, detail) => {
      const startedAt = performance.now()
      const readers: PaginationDiagnosticFields[] = []
      for (const source of sources) {
        try {
          const state = source.read()
          if (scope == null || state.scope === scope) readers.push({ source: source.name, ...state })
        } catch { sourceReadErrors += 1; readers.push({ source: source.name, readError: true }) }
      }
      const key = `${scope ?? "none"}:${phase}:${event}`
      counts[key] = (counts[key] ?? 0) + 1
      const record = { sequence: ++sequence,
        timeOrigin: performance.timeOrigin, startedAt, endedAt: performance.now(), epoch: Date.now(),
        scope: scope ?? null, phase, event, count: counts[key], detail: detail ?? null, readers }
      if (records.length === limit) { records.shift(); dropped += 1 }
      records.push(record)
      if (event.endsWith("rejected") && !first.has(key)) {
        first.add(key)
        firstRejections.push(record)
      }
    },
    checkpoint: (scope, next) => { phase = next; observer.capture(scope, "checkpoint") },
    packet: () => ({ schema: "message-pagination-diagnostic-v1", clock: "same-document performance milliseconds; synchronous reader interval",
      timeOrigin: performance.timeOrigin, phase, counts, dropped, sourceReadErrors,
      observerFailures: observer.observerFailures, activeSources: sources.size, firstRejections, records }),
  }
  window.__alookPaginationDiagnostics = observer
}

export async function installPaginationDiagnostics(page: Page, scope: string, info: TestInfo,
  onCleanup: (operation: () => Promise<unknown>) => void) {
  await page.addInitScript(installMessagePaginationDiagnostics)
  await page.evaluate(installMessagePaginationDiagnostics)
  onCleanup(async () => {
    const packet = page.isClosed() ? { schema: "message-pagination-diagnostic-v1", unavailable: "page-closed" }
      : await page.evaluate(scope => {
        const observer = window.__alookPaginationDiagnostics
        if (!observer) return { schema: "message-pagination-diagnostic-v1", unavailable: "observer-absent" }
        observer.checkpoint(scope, "cleanup-final")
        return observer.packet()
      }, scope)
    await info.attach("message-pagination-diagnostic.json", { body: JSON.stringify(packet), contentType: "application/json" })
  })
}
