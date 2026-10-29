import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { createStore } from "@tanstack/store"
import { BUSINESS_UPDATE_MARKER, CURRENT_DOCUMENT_REQUEST, WORKER_VERSION_PROBE, businessUpdateUrl, probeBusinessVersion } from "./service-worker/business-upgrade"

type UpdateState = { phase: "current" | "updating" | "failed"; expectedVersion: number }
export const businessSchemaLifecycle = createStore<UpdateState>({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION })
const owners = new Set<() => Promise<void>>()
const attemptKey = "alook:business-schema-update-attempt"

export class BusinessSchemaMismatch extends Error {
  constructor(public expectedVersion = BUSINESS_SCHEMA_VERSION as number) {
    super("This page needs an update")
    this.name = "BusinessSchemaMismatch"
  }
}

export function registerBusinessSchemaOwner(retire: () => Promise<void>) {
  owners.add(retire)
  if (businessSchemaLifecycle.get().phase !== "current") void retire()
  return () => { owners.delete(retire) }
}

export function rememberBusinessUpdateAttempt() {
  const marker = new URL(window.location.href).searchParams.get(BUSINESS_UPDATE_MARKER)
  if (marker) try { sessionStorage.setItem(attemptKey, marker) } catch { }
}

export function requestBusinessSchemaUpdate(expectedVersion: number = BUSINESS_SCHEMA_VERSION) {
  const expected = Number.isSafeInteger(expectedVersion) && expectedVersion > 0 ? Math.max(BUSINESS_SCHEMA_VERSION, expectedVersion) : BUSINESS_SCHEMA_VERSION
  const error = new BusinessSchemaMismatch(expected)
  if (typeof window !== "undefined" && businessSchemaLifecycle.get().phase === "current") void updateDocument(expected, false)
  return error
}

export function retryBusinessSchemaUpdate() {
  if (businessSchemaLifecycle.get().phase === "failed") void updateDocument(businessSchemaLifecycle.get().expectedVersion, true)
}

async function updateDocument(expectedVersion: number, explicitRetry: boolean) {
  businessSchemaLifecycle.setState(() => ({ phase: "updating", expectedVersion }))
  await withDeadline(Promise.allSettled([...owners].map(async retire => retire())), 3000).catch(() => undefined)
  try {
    const marker = new URL(window.location.href).searchParams.get(BUSINESS_UPDATE_MARKER)
    let previous: string | null = marker
    try { previous = sessionStorage.getItem(attemptKey) ?? marker } catch { }
    if (!explicitRetry && previous === String(expectedVersion)) throw new BusinessSchemaMismatch(expectedVersion)
    if (!("serviceWorker" in navigator)) {
      const next = businessUpdateUrl(window.location.href, expectedVersion)
      if (!next) throw new BusinessSchemaMismatch(expectedVersion)
      try { sessionStorage.setItem(attemptKey, String(expectedVersion)) } catch { }
      window.location.replace(next)
      return
    }
    const registration = await withDeadline(navigator.serviceWorker.getRegistration(), 10_000)
    if (!registration) throw new BusinessSchemaMismatch(expectedVersion)
    await withDeadline(registration.update(), 10_000)
    registration.waiting?.postMessage({ type: "SKIP_WAITING" })
    const worker = await currentWorker(registration, expectedVersion)
    const next = new URL(window.location.href)
    if (explicitRetry) next.searchParams.delete(BUSINESS_UPDATE_MARKER)
    if (!businessUpdateUrl(next.href, expectedVersion)) throw new BusinessSchemaMismatch(expectedVersion)
    try { sessionStorage.setItem(attemptKey, String(expectedVersion)) } catch { }
    const channel = new MessageChannel()
    await withDeadline(new Promise<void>((resolve, reject) => {
      channel.port1.onmessage = event => {
        channel.port1.close()
        channel.port2.close()
        if (event.data?.navigating === true) resolve()
        else reject(new BusinessSchemaMismatch(expectedVersion))
      }
      worker.postMessage({ type: CURRENT_DOCUMENT_REQUEST, schemaVersion: expectedVersion, explicitRetry }, [channel.port2])
    }), 10_000).finally(() => { channel.port1.close(); channel.port2.close() })
  } catch {
    businessSchemaLifecycle.setState(() => ({ phase: "failed", expectedVersion }))
  }
}

async function currentWorker(registration: ServiceWorkerRegistration, expectedVersion: number): Promise<ServiceWorker> {
  return new Promise((resolve, reject) => {
    let checking = false
    let pending = false
    let finished = false
    let installing: ServiceWorker | null = null
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener("controllerchange", check)
      registration.removeEventListener("updatefound", watchInstalling)
      installing?.removeEventListener("statechange", check)
    }
    const check = async () => {
      if (finished) return
      if (checking) { pending = true; return }
      checking = true
      do {
        pending = false
        registration.waiting?.postMessage({ type: "SKIP_WAITING" })
        const worker = navigator.serviceWorker.controller ?? registration.active
        const version = worker ? await probeBusinessVersion(worker, WORKER_VERSION_PROBE) : null
        if (finished) return
        if (worker && version === expectedVersion && worker === (navigator.serviceWorker.controller ?? registration.active)) {
          cleanup(); resolve(worker); return
        }
      } while (pending)
      checking = false
    }
    const watchInstalling = () => {
      installing?.removeEventListener("statechange", check)
      installing = registration.installing
      installing?.addEventListener("statechange", check)
      void check()
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error("Update unavailable")) }, 10_000)
    navigator.serviceWorker.addEventListener("controllerchange", check)
    registration.addEventListener("updatefound", watchInstalling)
    watchInstalling()
  })
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Update unavailable")), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
