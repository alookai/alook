import { useLayoutEffect } from "react"

export type PaginationDiagnosticFields = Record<string, unknown>
export type PaginationDiagnosticSource = { name: string; read: () => PaginationDiagnosticFields }
export type PaginationDiagnosticBridge = {
  sources: Set<PaginationDiagnosticSource>
  observerFailures: number
  capture: (scope: string | null | undefined, event: string, detail?: PaginationDiagnosticFields) => void
  id: (value: object) => number
  checkpoint: (scope: string | null | undefined, phase: string) => void
  packet: () => PaginationDiagnosticFields
}

declare global {
  interface Window { __alookPaginationDiagnostics?: PaginationDiagnosticBridge }
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.__alookPaginationDiagnostics
}

function failed(observer: PaginationDiagnosticBridge) {
  try { observer.observerFailures += 1 } catch {}
}

export function paginationDiagnosticId(value: unknown) {
  const observer = bridge()
  if (!observer || !value || typeof value !== "object") return null
  try { return observer.id(value) } catch { failed(observer); return null }
}

export function paginationDiagnostic(scope: string | null | undefined, event: string, detail?: () => PaginationDiagnosticFields) {
  const observer = bridge()
  if (!observer) return
  try { observer.capture(scope, event, detail?.()) } catch { failed(observer) }
}

export function usePaginationDiagnosticSource(name: string, read: () => PaginationDiagnosticFields) {
  useLayoutEffect(() => {
    const observer = bridge()
    if (!observer) return
    const source = { name, read }
    try { observer.sources.add(source) } catch { failed(observer); return }
    return () => { try { observer.sources.delete(source) } catch { failed(observer) } }
  })
}
