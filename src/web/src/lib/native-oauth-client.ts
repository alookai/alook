import {
  isSafeRedirectPath,
  nativeOauthRegistrationSchema,
  nativeOauthProofSchema,
  nativeOauthExchangeSchema,
  tauriInvoke,
  type NativeOauthProvider,
} from "@alook/shared"
import { z } from "zod"
import { nativeOauthSnapshotSchema, type NativeOauthSnapshot } from "@/lib/native-oauth-schema"

const exchangeSchema = nativeOauthProofSchema.extend({
  candidateId: z.string(), code: z.string().nullable(), status: z.string().nullable(), wasDispatched: z.boolean(),
}).strict()
export type { NativeOauthSnapshot } from "@/lib/native-oauth-schema"
export type NativeOauthView = {
  phase: "initializing" | "idle" | "preparing" | "waiting" | "exchanging" | "checking_status" | "error" | "unsupported"
  message?: "start_failed" | "expired" | "denied" | "invalid_callback" | "retry_required" | "unavailable" | "apple_update_required"
  attempt: NativeOauthSnapshot | null
}
export type NativeOauthDeps = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  listen: (ready: () => void) => Promise<() => void>
  post: (endpoint: string, body: unknown) => Promise<{ ok: boolean; data: unknown }>
  hasSession: () => Promise<boolean>
  navigate: (path: string) => void
}

export function createNativeOauthController(deps: NativeOauthDeps, changed: (view: NativeOauthView) => void) {
  let view: NativeOauthView = { phase: "initializing", attempt: null }
  let generation = 0
  let disposed = false
  let connected = false
  let stopListening: (() => void) | undefined
  let processing = false
  let wakeAgain = false
  let startQueue = Promise.resolve()
  let expiry: ReturnType<typeof setTimeout> | undefined
  const publish = (next: NativeOauthView) => {
    view = next
    if (!disposed) { setAttempt(next.attempt); changed(next) }
  }
  const current = (version: number) => !disposed && generation === version
  const setAttempt = (attempt: NativeOauthSnapshot | null) => {
    clearTimeout(expiry)
    if (attempt) expiry = setTimeout(() => {
      if (!disposed && view.attempt?.attemptId === attempt.attemptId) {
        generation += 1
        publish({ phase: "error", message: "expired", attempt: null })
        void deps.invoke("native_oauth_snapshot").catch(() => {})
      }
    }, Math.max(0, attempt.expiresAt - Date.now()))
  }
  const readSnapshot = async () => {
    const result = nativeOauthSnapshotSchema.nullable().parse(await deps.invoke("native_oauth_snapshot"))
    return result
  }
  const finish = async (attemptId: string, candidateId: string) => {
    await deps.invoke("native_oauth_finish", { attemptId, candidateId })
  }
  const confirmSession = async () => {
    try { return await deps.hasSession() } catch { return false }
  }
  const drain = async () => {
    if (disposed || !connected) return
    if (processing) { wakeAgain = true; return }
    processing = true
    const version = generation
    try {
      do {
        wakeAgain = false
        const candidate = exchangeSchema.nullable().parse(await deps.invoke("native_oauth_pending_exchange"))
        if (!current(version)) return
        if (!candidate) return
        const snapshot = await readSnapshot()
        if (!current(version)) return
        if (!snapshot || snapshot.attemptId !== candidate.attemptId) continue
        const { attemptId, state, verifier, candidateId } = candidate
        const proof = { attemptId, state, verifier }
        if (candidate.wasDispatched && candidate.code) {
          if (await confirmSession()) {
            if (!current(version)) return
            await finish(attemptId, candidateId)
            if (current(version)) deps.navigate(snapshot.redirectPath)
          } else if (current(version)) {
            publish({ phase: "error", message: "retry_required", attempt: snapshot })
          }
          return
        }
        publish({ phase: candidate.code ? "exchanging" : "checking_status", attempt: snapshot })
        try {
          if (candidate.code) {
            const body = nativeOauthExchangeSchema.parse({ ...proof, code: candidate.code })
            const response = await deps.post("exchange", body)
            if (!current(version)) return
            const success = z.object({ redirectPath: z.string().refine(isSafeRedirectPath) }).strict().safeParse(response.data)
            if (response.ok && success.success) {
              await finish(attemptId, candidateId)
              if (current(version)) deps.navigate(success.data.redirectPath)
              return
            }
            const failure = z.object({ error: z.literal("invalid_handoff") }).strict().safeParse(response.data)
            if (!failure.success) throw new Error("exchange_unconfirmed")
            await deps.invoke("native_oauth_reject_candidate", { attemptId, candidateId })
            if (!current(version)) return
            publish({ phase: "waiting", message: "invalid_callback", attempt: snapshot })
            wakeAgain = true
            continue
          }
          const statusResponse = await deps.post("status", proof)
          if (!current(version)) return
          const status = z.object({ status: z.enum(["pending", "opened", "ready", "exchanging", "consumed", "failed", "cancelled", "replaced", "expired", "unknown"]), failure: z.string().optional() }).strict().parse(statusResponse.data)
          if (!statusResponse.ok) throw new Error("status_unavailable")
          if (["failed", "cancelled", "replaced", "expired", "unknown", "consumed"].includes(status.status)) {
            const signedIn = status.status === "consumed" && await confirmSession()
            if (!current(version)) return
            await finish(attemptId, candidateId)
            if (!current(version)) return
            setAttempt(null)
            if (signedIn) deps.navigate(snapshot.redirectPath)
            else publish({ phase: "error", message: status.failure === "access_denied" ? "denied" : "retry_required", attempt: null })
            return
          }
          await deps.invoke("native_oauth_reject_candidate", { attemptId, candidateId })
          if (!current(version)) return
          publish({ phase: "waiting", message: "invalid_callback", attempt: snapshot })
          wakeAgain = true
        } catch {
          const signedIn = !!candidate.code && await confirmSession()
          if (!current(version)) return
          if (signedIn) {
            await finish(attemptId, candidateId)
            if (current(version)) deps.navigate(snapshot.redirectPath)
          } else publish({ phase: "error", message: "retry_required", attempt: snapshot })
          return
        }
      } while (wakeAgain && current(version))
    } catch {
      if (current(version)) publish({ phase: "error", message: "unavailable", attempt: view.attempt })
    } finally {
      processing = false
      if (wakeAgain && !disposed) { wakeAgain = false; void drain() }
    }
  }
  return {
    async connect() {
      publish({ phase: "initializing", attempt: null })
      try {
        const unsubscribe = await deps.listen(() => { void drain() })
        if (disposed) { unsubscribe(); return }
        stopListening = unsubscribe
        const attempt = await readSnapshot()
        if (disposed) return
        connected = true
        publish({ phase: attempt?.waiting ? "waiting" : "idle", attempt })
        await drain()
      } catch (error) {
        if (!disposed) publish(error === "store_unavailable"
          ? { phase: "error", message: "unavailable", attempt: null }
          : { phase: "unsupported", attempt: null })
      }
    },
    start(provider: NativeOauthProvider, redirectPath: string) {
      if (disposed || !connected || !isSafeRedirectPath(redirectPath)) return Promise.resolve()
      const version = ++generation
      publish({ phase: "preparing", attempt: view.attempt })
      const task = async () => {
        if (!current(version)) return
        let attemptId: string | undefined
        try {
          const registration = nativeOauthRegistrationSchema.parse(await deps.invoke("native_oauth_prepare", { provider, redirectPath }))
          attemptId = registration.attemptId
          if (!current(version)) return
          const attempt = await readSnapshot()
          if (!current(version)) return
          publish({ phase: "preparing", attempt })
          const response = await deps.post("attempt", registration)
          if (!current(version)) return
          const data = z.object({ startUrl: z.string() }).strict().parse(response.data)
          if (!response.ok) throw new Error("registration_failed")
          await deps.invoke("native_oauth_open_start", { attemptId, startUrl: data.startUrl })
          if (!current(version)) return
          const waiting = await readSnapshot()
          if (!current(version)) return
          publish({ phase: "waiting", attempt: waiting })
          void drain()
        } catch (error) {
          if (!current(version)) return
          if (attemptId) {
            const proof = await deps.invoke("native_oauth_cancel", { attemptId }).catch(() => null)
            if (proof) await deps.post("cancel", nativeOauthProofSchema.parse(proof)).catch(() => {})
          }
          const nativeError = typeof error === "string"
            ? error
            : error instanceof Error
            ? error.message
            : ""
          const message = provider === "apple" && !attemptId && nativeError === "invalid_request"
            ? "apple_update_required"
            : "start_failed"
          if (current(version)) { setAttempt(null); publish({ phase: "error", message, attempt: null }) }
        }
      }
      startQueue = startQueue.then(task, task)
      return startQueue
    },
    async cancel() {
      const version = ++generation
      const attempt = view.attempt
      try {
        const proof = await deps.invoke("native_oauth_cancel")
        if (current(version)) { setAttempt(null); publish({ phase: "idle", attempt: null }) }
        if (proof) await deps.post("cancel", nativeOauthProofSchema.parse(proof)).catch(() => {})
      } catch {
        if (current(version)) publish({ phase: "error", message: "unavailable", attempt })
      }
    },
    dispose() {
      disposed = true
      generation += 1
      clearTimeout(expiry)
      stopListening?.()
    },
  }
}

async function request(path: string, body?: unknown) {
  return fetch(path, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  })
}

export const nativeOauthBrowserDeps: NativeOauthDeps = {
  invoke: tauriInvoke,
  async listen(ready) {
    const bridge = (window as unknown as { __TAURI__?: { core?: { Channel?: new () => { onmessage: () => void } } } }).__TAURI__
    const Channel = bridge?.core?.Channel
    if (!Channel) throw new Error("native_bridge_unavailable")
    const channel = new Channel()
    channel.onmessage = ready
    const registrationId = await tauriInvoke<number>("native_oauth_listen", { channel })
    return () => { void tauriInvoke("native_oauth_unlisten", { registrationId }).catch(() => {}) }
  },
  async post(endpoint, body) {
    const response = await request(`/api/auth/native/${endpoint}`, body)
    return { ok: response.ok, data: await response.json() }
  },
  async hasSession() {
    const response = await request("/api/auth/get-session?disableCookieCache=true")
    const result = z.object({ session: z.object({ id: z.string() }).passthrough().nullable() }).passthrough().safeParse(await response.json())
    return response.ok && result.success && result.data.session !== null
  },
  navigate(path) { window.location.assign(path) },
}
