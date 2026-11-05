import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { createStore } from "@tanstack/store"
import { BUSINESS_UPDATE_MARKER, CURRENT_DOCUMENT_REQUEST, WORKER_VERSION_PROBE, businessUpdateUrl, probeBusinessVersion } from "./service-worker/business-upgrade"

type UpdateState = { phase: "current" | "updating" | "failed"; expectedVersion: number }
export const businessSchemaLifecycle = createStore<UpdateState>({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION })
type Owner = { retire: () => Promise<void>; registered: boolean; retired: boolean; pending?: Promise<void>; failure?: { attempt: number; error: unknown } }
const owners = new Set<Owner>()
let attempt = 0
const attemptKey = "alook:business-schema-update-attempt"

export class BusinessSchemaMismatch extends Error {
  constructor(public expectedVersion = BUSINESS_SCHEMA_VERSION as number, message = "This page needs an update") {
    super(message)
    this.name = "BusinessSchemaMismatch"
  }
}

function retireOwner(owner: Owner, currentAttempt: number): Promise<void> {
  if (owner.retired) return Promise.resolve()
  if (owner.pending) return owner.pending
  if (owner.failure?.attempt === currentAttempt) return Promise.reject(owner.failure.error)
  let retirement: Promise<void>
  try { retirement = owner.retire() } catch (error) { retirement = Promise.reject(error) }
  owner.pending = Promise.resolve(retirement).then(() => {
    owner.retired = true
    if (!owner.registered) owners.delete(owner)
  }, error => {
    owner.failure = { attempt: currentAttempt, error }
    throw error
  }).finally(() => { owner.pending = undefined })
  return owner.pending
}

export function registerBusinessSchemaOwner(retire: () => Promise<void>) {
  const owner: Owner = { retire, registered: true, retired: false }
  owners.add(owner)
  if (businessSchemaLifecycle.get().phase !== "current") void retireOwner(owner, attempt).catch(() => undefined)
  return () => {
    owner.registered = false
    if (owner.retired || businessSchemaLifecycle.get().phase === "current") owners.delete(owner)
  }
}

async function retireOwners(currentAttempt: number) {
  while ([...owners].some(owner => !owner.retired)) {
    await Promise.all([...owners].map(owner => retireOwner(owner, currentAttempt)))
  }
}

export function rememberBusinessUpdateAttempt() {
  const marker = new URL(window.location.href).searchParams.get(BUSINESS_UPDATE_MARKER)
  if (marker) try { sessionStorage.setItem(attemptKey, marker) } catch { }
}

export function requestBusinessSchemaUpdate(expectedVersion: number = BUSINESS_SCHEMA_VERSION) {
  const expected = Number.isSafeInteger(expectedVersion) && expectedVersion > 0 ? Math.max(BUSINESS_SCHEMA_VERSION, expectedVersion) : BUSINESS_SCHEMA_VERSION
  const error = new BusinessSchemaMismatch(expected)
  if (typeof window !== "undefined") {
    const state = businessSchemaLifecycle.get()
    if (state.phase === "current") void updateDocument(expected, false)
    else if (expected > state.expectedVersion) businessSchemaLifecycle.setState(() => ({ ...state, expectedVersion: expected }))
  }
  return error
}

export function retryBusinessSchemaUpdate() {
  if (businessSchemaLifecycle.get().phase === "failed") void updateDocument(businessSchemaLifecycle.get().expectedVersion, true)
}

async function updateDocument(expectedVersion: number, explicitRetry: boolean) {
  const currentAttempt = ++attempt
  businessSchemaLifecycle.setState(() => ({ phase: "updating", expectedVersion }))
  try {
    await retireOwners(currentAttempt)
    const marker = new URL(window.location.href).searchParams.get(BUSINESS_UPDATE_MARKER)
    let previous: string | null = marker
    try { previous = sessionStorage.getItem(attemptKey) ?? marker } catch { }
    expectedVersion = businessSchemaLifecycle.get().expectedVersion
    if (!explicitRetry && previous === String(expectedVersion)) throw new BusinessSchemaMismatch(expectedVersion)
    if (!("serviceWorker" in navigator)) {
      const url = new URL(window.location.href)
      if (explicitRetry) url.searchParams.delete(BUSINESS_UPDATE_MARKER)
      const next = businessUpdateUrl(url.href, expectedVersion)
      if (!next) throw new BusinessSchemaMismatch(expectedVersion)
      try { sessionStorage.setItem(attemptKey, String(expectedVersion)) } catch { }
      window.location.replace(next)
      return
    }
    const registration = await withDeadline(navigator.serviceWorker.getRegistration(), 10_000)
      ?? await withDeadline(navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }), 10_000)
    await withDeadline(registration.update(), 10_000)
    registration.waiting?.postMessage({ type: "SKIP_WAITING" })
    let current = await currentWorker(registration)
    await retireOwners(currentAttempt)
    while (current.version < businessSchemaLifecycle.get().expectedVersion
      || current.worker !== (navigator.serviceWorker.controller ?? registration.active)) {
      current = await currentWorker(registration)
      await retireOwners(currentAttempt)
    }
    expectedVersion = current.version
    businessSchemaLifecycle.setState(() => ({ phase: "updating", expectedVersion }))
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
      current.worker.postMessage({ type: CURRENT_DOCUMENT_REQUEST, schemaVersion: expectedVersion, explicitRetry }, [channel.port2])
    }), 10_000).finally(() => { channel.port1.close(); channel.port2.close() })
  } catch {
    businessSchemaLifecycle.setState(state => ({ phase: "failed", expectedVersion: Math.max(expectedVersion, state.expectedVersion) }))
  }
}

async function currentWorker(registration: ServiceWorkerRegistration): Promise<{ worker: ServiceWorker; version: number }> {
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
        if (worker && version !== null && version >= businessSchemaLifecycle.get().expectedVersion
          && worker === (navigator.serviceWorker.controller ?? registration.active)) {
          cleanup(); resolve({ worker, version }); return
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
