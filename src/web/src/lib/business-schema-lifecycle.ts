import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { createStore } from "@tanstack/store"
import { BUSINESS_UPDATE_MARKER, CURRENT_DOCUMENT_REQUEST, WORKER_VERSION_PROBE, businessUpdateMarker, businessUpdateUrl, isCurrentBusinessDocument, probeBusinessIdentity } from "./service-worker/business-upgrade"
import { WEB_BUILD_ID } from "./web-build"

type UpdateState = { phase: "current" | "updating" | "failed"; expectedVersion: number; expectedBuildId?: string }
export const businessSchemaLifecycle = createStore<UpdateState>({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION })
type Owner = { retire: (invalidatePersisted: boolean) => Promise<void>; registered: boolean; retired: false | "build" | "schema"; pending?: Promise<void>; failure?: { attempt: number; purpose: "build" | "schema"; error: unknown } }
const owners = new Set<Owner>()
let attempt = 0
let schemaRetirement = true
const attemptKey = "alook:business-schema-update-attempt"

export class BusinessSchemaMismatch extends Error {
  constructor(public expectedVersion = BUSINESS_SCHEMA_VERSION as number, message = "This page needs an update") {
    super(message)
    this.name = "BusinessSchemaMismatch"
  }
}

function retireOwner(owner: Owner, currentAttempt: number): Promise<void> {
  if (!isCurrentBusinessDocument()) return Promise.resolve()
  const purpose = schemaRetirement ? "schema" : "build"
  if (owner.retired === "schema" || owner.retired === purpose) return Promise.resolve()
  if (owner.pending) return owner.pending
  if (owner.failure?.attempt === currentAttempt && owner.failure.purpose === purpose) return Promise.reject(owner.failure.error)
  let retirement: Promise<void>
  try { retirement = owner.retire(schemaRetirement) } catch (error) { retirement = Promise.reject(error) }
  owner.pending = Promise.resolve(retirement).then(() => {
    owner.retired = purpose
    if (!owner.registered && owner.retired === "schema") owners.delete(owner)
  }, error => {
    owner.failure = { attempt: currentAttempt, purpose, error }
    throw error
  }).finally(() => { owner.pending = undefined })
  return owner.pending
}

export function registerBusinessSchemaOwner(retire: (invalidatePersisted: boolean) => Promise<void>) {
  const owner: Owner = { retire, registered: true, retired: false }
  owners.add(owner)
  if (isCurrentBusinessDocument() && businessSchemaLifecycle.get().phase !== "current") void retireOwner(owner, attempt).catch(() => undefined)
  return () => {
    owner.registered = false
    if (owner.retired === "schema" || businessSchemaLifecycle.get().phase === "current") owners.delete(owner)
  }
}

async function retireOwners(currentAttempt: number) {
  while (isCurrentBusinessDocument() && [...owners].some(owner => !owner.retired || schemaRetirement && owner.retired !== "schema")) {
    await Promise.all([...owners].map(owner => retireOwner(owner, currentAttempt)))
  }
}

export function rememberBusinessUpdateAttempt() {
  if (!isCurrentBusinessDocument()) return
  const marker = new URL(window.location.href).searchParams.get(BUSINESS_UPDATE_MARKER)
  if (marker) try { sessionStorage.setItem(attemptKey, marker) } catch { }
}

export function requestBusinessSchemaUpdate(expectedVersion: number = BUSINESS_SCHEMA_VERSION) {
  const expected = Number.isSafeInteger(expectedVersion) && expectedVersion > 0 ? Math.max(BUSINESS_SCHEMA_VERSION, expectedVersion) : BUSINESS_SCHEMA_VERSION
  const error = new BusinessSchemaMismatch(expected)
  if (isCurrentBusinessDocument()) {
    schemaRetirement = true
    const state = businessSchemaLifecycle.get()
    if (state.phase === "current") void updateDocument(expected, false)
    else {
      if (expected > state.expectedVersion) businessSchemaLifecycle.setState(() => ({ ...state, expectedVersion: expected }))
      void retireOwners(attempt).catch(() => undefined)
    }
  }
  return error
}

export function requestDocumentBuildUpdate(buildId: string) {
  if (!isCurrentBusinessDocument() || buildId === WEB_BUILD_ID || !/^[a-zA-Z0-9_-]{1,128}$/.test(buildId)) return
  const state = businessSchemaLifecycle.get()
  if (state.phase === "current") void updateDocument(BUSINESS_SCHEMA_VERSION, false, buildId, false)
  else if (!schemaRetirement && state.expectedBuildId !== buildId) businessSchemaLifecycle.setState(() => ({ ...state, expectedBuildId: buildId }))
}

export function retryBusinessSchemaUpdate() {
  const state = businessSchemaLifecycle.get()
  if (isCurrentBusinessDocument() && state.phase === "failed") void updateDocument(state.expectedVersion, true, state.expectedBuildId, schemaRetirement)
}

async function updateDocument(expectedVersion: number, explicitRetry: boolean, expectedBuildId?: string, invalidatePersisted = true) {
  if (!isCurrentBusinessDocument()) return
  const currentAttempt = ++attempt
  schemaRetirement = invalidatePersisted
  businessSchemaLifecycle.setState(() => ({ phase: "updating", expectedVersion, ...(expectedBuildId ? { expectedBuildId } : {}) }))
  try {
    await retireOwners(currentAttempt)
    if (!isCurrentBusinessDocument()) return
    const marker = new URL(window.location.href).searchParams.get(BUSINESS_UPDATE_MARKER)
    let previous: string | null = marker
    try { previous = sessionStorage.getItem(attemptKey) ?? marker } catch { }
    expectedVersion = businessSchemaLifecycle.get().expectedVersion
    expectedBuildId = businessSchemaLifecycle.get().expectedBuildId
    if (!explicitRetry && previous === businessUpdateMarker(expectedVersion, expectedBuildId)) throw new BusinessSchemaMismatch(expectedVersion)
    if (!("serviceWorker" in navigator)) {
      const url = new URL(window.location.href)
      if (explicitRetry) url.searchParams.delete(BUSINESS_UPDATE_MARKER)
      const next = businessUpdateUrl(url.href, expectedVersion, expectedBuildId)
      if (!next) throw new BusinessSchemaMismatch(expectedVersion)
      try { sessionStorage.setItem(attemptKey, businessUpdateMarker(expectedVersion, expectedBuildId)) } catch { }
      window.location.replace(next)
      return
    }
    let registration = await withDeadline(navigator.serviceWorker.getRegistration(), 10_000)
    if (!isCurrentBusinessDocument()) return
    registration ??= await withDeadline(navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }), 10_000)
    if (!isCurrentBusinessDocument()) return
    await withDeadline(registration.update(), 10_000)
    if (!isCurrentBusinessDocument()) return
    registration.waiting?.postMessage({ type: "SKIP_WAITING" })
    let current = await currentWorker(registration)
    if (!isCurrentBusinessDocument()) return
    await retireOwners(currentAttempt)
    if (!isCurrentBusinessDocument()) return
    while (current.version < businessSchemaLifecycle.get().expectedVersion
      || current.worker !== (navigator.serviceWorker.controller ?? registration.active)) {
      current = await currentWorker(registration)
      if (!isCurrentBusinessDocument()) return
      await retireOwners(currentAttempt)
      if (!isCurrentBusinessDocument()) return
    }
    expectedVersion = current.version
    expectedBuildId = current.buildId
    businessSchemaLifecycle.setState(() => ({ phase: "updating", expectedVersion, ...(expectedBuildId ? { expectedBuildId } : {}) }))
    const next = new URL(window.location.href)
    if (explicitRetry) next.searchParams.delete(BUSINESS_UPDATE_MARKER)
    if (!businessUpdateUrl(next.href, expectedVersion, expectedBuildId)) throw new BusinessSchemaMismatch(expectedVersion)
    try { sessionStorage.setItem(attemptKey, businessUpdateMarker(expectedVersion, expectedBuildId)) } catch { }
    const channel = new MessageChannel()
    await withDeadline(new Promise<void>((resolve, reject) => {
      channel.port1.onmessage = event => {
        channel.port1.close()
        channel.port2.close()
        if (event.data?.navigating === true) resolve()
        else reject(new BusinessSchemaMismatch(expectedVersion))
      }
      current.worker.postMessage({ type: CURRENT_DOCUMENT_REQUEST, schemaVersion: expectedVersion, ...(expectedBuildId ? { buildId: expectedBuildId } : {}), explicitRetry }, [channel.port2])
    }), 10_000).finally(() => { channel.port1.close(); channel.port2.close() })
  } catch {
    if (isCurrentBusinessDocument()) businessSchemaLifecycle.setState(state => ({ ...state, phase: "failed", expectedVersion: Math.max(expectedVersion, state.expectedVersion) }))
  } finally {
    if (!isCurrentBusinessDocument()) businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
  }
}

async function currentWorker(registration: ServiceWorkerRegistration): Promise<{ worker: ServiceWorker; version: number; buildId?: string }> {
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
      if (!isCurrentBusinessDocument()) { cleanup(); reject(new Error("Document left business routes")); return }
      if (checking) { pending = true; return }
      checking = true
      do {
        pending = false
        registration.waiting?.postMessage({ type: "SKIP_WAITING" })
        const worker = navigator.serviceWorker.controller ?? registration.active
        const identity = worker ? await probeBusinessIdentity(worker, WORKER_VERSION_PROBE) : null
        if (finished) return
        if (!isCurrentBusinessDocument()) { cleanup(); reject(new Error("Document left business routes")); return }
        if (worker && identity !== null && identity.schemaVersion >= businessSchemaLifecycle.get().expectedVersion
          && (schemaRetirement || !!identity.buildId && identity.buildId !== WEB_BUILD_ID)
          && worker === (navigator.serviceWorker.controller ?? registration.active)) {
          cleanup(); resolve({ worker, version: identity.schemaVersion, ...(identity.buildId ? { buildId: identity.buildId } : {}) }); return
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
