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
export type NativeOauthWakeReason = "candidate_ready" | "window_resumed"
export type NativeOauthDeps = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  listen: (ready: (reason?: NativeOauthWakeReason) => void) => Promise<() => void>
  post: (endpoint: string, body: unknown) => Promise<{ ok: boolean; data: unknown }>
  hasSession: () => Promise<boolean>
  readSessionId?: () => Promise<string | null>
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
  let wakeReasonAgain: NativeOauthWakeReason | undefined
  let baselineSessionId: string | null = null
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
  const cancelOrphanedAttempt = async (attemptId: string) => {
    const proof = await deps.invoke("native_oauth_cancel", { attemptId }).catch(() => null)
    if (proof) await deps.post("cancel", nativeOauthProofSchema.parse(proof)).catch(() => {})
  }
  const captureBaselineSession = async () => {
    if (!deps.readSessionId) {
      baselineSessionId = null
      return
    }
    try {
      baselineSessionId = await deps.readSessionId()
    } catch {
      baselineSessionId = null
    }
  }
  const confirmSession = async () => {
    try {
      if (deps.readSessionId) {
        const sessionId = await deps.readSessionId()
        if (!sessionId) return false
        if (baselineSessionId !== null && sessionId === baselineSessionId) return false
        return true
      }
      return await deps.hasSession()
    } catch {
      return false
    }
  }
  const mergeWakeReason = (
    existing: NativeOauthWakeReason | undefined,
    incoming: NativeOauthWakeReason | undefined,
  ): NativeOauthWakeReason | undefined => {
    if (existing === "candidate_ready" || incoming === "candidate_ready") return "candidate_ready"
    return incoming ?? existing
  }
  const drain = async (reason?: NativeOauthWakeReason) => {
    if (disposed || !connected) return
    if (processing) {
      wakeAgain = true
      wakeReasonAgain = mergeWakeReason(wakeReasonAgain, reason)
      return
    }
    processing = true
    const version = generation
    let activeReason = reason
    try {
      do {
        activeReason = mergeWakeReason(activeReason, wakeReasonAgain)
        wakeReasonAgain = undefined
        wakeAgain = false
        const candidate = exchangeSchema.nullable().parse(await deps.invoke("native_oauth_pending_exchange"))
        if (!current(version)) return
        if (!candidate) {
          const attempt = view.attempt
          if (!activeReason || !attempt?.waiting) return
          const snapshot = await readSnapshot()
          if (!current(version)) return
          if (snapshot && snapshot.attemptId !== attempt.attemptId) {
            publish({ phase: snapshot.waiting ? "waiting" : "idle", attempt: snapshot })
            return
          }
          const signedIn = await confirmSession()
          if (!current(version)) return
          if (signedIn) {
            if (snapshot) {
              await cancelOrphanedAttempt(snapshot.attemptId)
              if (!current(version)) return
            }
            setAttempt(null)
            deps.navigate(attempt.redirectPath)
          } else if (activeReason === "window_resumed" && snapshot) {
            publish({ phase: "waiting", attempt: snapshot })
          } else if (!snapshot) {
            publish({ phase: "error", message: "retry_required", attempt: null })
          } else {
            publish({ phase: "waiting", attempt: snapshot })
          }
          return
        }
        activeReason = undefined
        const snapshot = await readSnapshot()
        if (!current(version)) return
        if (!snapshot || snapshot.attemptId !== candidate.attemptId) continue
        const { attemptId, state, verifier, candidateId } = candidate
        const proof = { attemptId, state, verifier }
        if (candidate.wasDispatched && candidate.code) {
          if (await confirmSession()) {
            if (!current(version)) return
            await finish(attemptId, candidateId)
            if (current(version)) {
              setAttempt(null)
              deps.navigate(snapshot.redirectPath)
            }
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
              const signedIn = await confirmSession()
              if (!current(version)) return
              if (!signedIn) {
                publish({ phase: "error", message: "retry_required", attempt: snapshot })
                return
              }
              await finish(attemptId, candidateId)
              if (current(version)) {
                setAttempt(null)
                deps.navigate(success.data.redirectPath)
              }
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
            if (current(version)) {
              setAttempt(null)
              deps.navigate(snapshot.redirectPath)
            }
          } else publish({ phase: "error", message: "retry_required", attempt: snapshot })
          return
        }
      } while (wakeAgain && current(version))
    } catch {
      if (current(version)) publish({ phase: "error", message: "unavailable", attempt: view.attempt })
    } finally {
      processing = false
      if (wakeAgain && !disposed) {
        const nextReason = wakeReasonAgain
        wakeAgain = false
        wakeReasonAgain = undefined
        void drain(nextReason)
      }
    }
  }
  const connectInternal = async (shouldDrain = true): Promise<boolean> => {
    stopListening?.()
    stopListening = undefined
    connected = false
    try {
      const unsubscribe = await deps.listen((reason) => {
        void drain(reason ?? "candidate_ready")
      })
      if (disposed) { unsubscribe(); return false }
      stopListening = unsubscribe
      const attempt = await readSnapshot()
      if (disposed) return false
      if (!attempt?.waiting) await captureBaselineSession()
      if (disposed) return false
      connected = true
      if (shouldDrain) {
        publish({ phase: attempt?.waiting ? "waiting" : "idle", attempt })
        await drain()
      }
      return true
    } catch (error) {
      if (!disposed) publish(error === "store_unavailable"
        ? { phase: "error", message: "unavailable", attempt: null }
        : { phase: "unsupported", attempt: null })
      return false
    }
  }
  return {
    async connect() {
      publish({ phase: "initializing", attempt: null })
      await connectInternal(true)
    },
    start(provider: NativeOauthProvider, redirectPath: string) {
      if (disposed || !isSafeRedirectPath(redirectPath)) return Promise.resolve()
      if (!connected && view.phase !== "error") return Promise.resolve()
      const version = ++generation
      publish({ phase: "preparing", attempt: view.attempt })
      const task = async () => {
        if (!current(version)) return
        let attemptId: string | undefined
        try {
          if (!connected) {
            const ready = await connectInternal(false)
            if (!ready || !current(version)) return
          }
          await captureBaselineSession()
          if (!current(version)) return
          const registration = nativeOauthRegistrationSchema.parse(await deps.invoke("native_oauth_prepare", { provider, redirectPath }))
          attemptId = registration.attemptId
          if (!current(version)) {
            await cancelOrphanedAttempt(attemptId)
            return
          }
          const attempt = await readSnapshot()
          if (!current(version)) {
            await cancelOrphanedAttempt(attemptId)
            return
          }
          publish({ phase: "preparing", attempt })
          const response = await deps.post("attempt", registration)
          if (!current(version)) {
            await cancelOrphanedAttempt(attemptId)
            return
          }
          const data = z.object({ startUrl: z.string() }).strict().parse(response.data)
          if (!response.ok) throw new Error("registration_failed")
          await deps.invoke("native_oauth_open_start", { attemptId, startUrl: data.startUrl })
          if (!current(version)) {
            await cancelOrphanedAttempt(attemptId)
            return
          }
          const waiting = await readSnapshot()
          if (!current(version)) {
            await cancelOrphanedAttempt(attemptId)
            return
          }
          publish({ phase: "waiting", attempt: waiting })
          void drain()
        } catch (error) {
          if (attemptId) {
            await cancelOrphanedAttempt(attemptId)
          }
          if (!current(version)) return
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

async function readBrowserSessionId(): Promise<string | null> {
  const response = await request("/api/auth/get-session?disableCookieCache=true")
  if (!response.ok) return null
  const result = z.object({ session: z.object({ id: z.string().min(1) }).loose().nullable() }).loose().safeParse(await response.json())
  return result.success ? result.data.session?.id ?? null : null
}

export const nativeOauthBrowserDeps: NativeOauthDeps = {
  invoke: tauriInvoke,
  async listen(ready) {
    const bridge = (window as unknown as { __TAURI__?: { core?: { Channel?: new () => { onmessage: (payload?: unknown) => void } } } }).__TAURI__
    const Channel = bridge?.core?.Channel
    if (!Channel) throw new Error("native_bridge_unavailable")
    const channel = new Channel()
    channel.onmessage = (payload?: unknown) => {
      ready(payload === "window_resumed" ? "window_resumed" : "candidate_ready")
    }
    const registrationId = await tauriInvoke<number>("native_oauth_listen", { channel })
    return () => { void tauriInvoke("native_oauth_unlisten", { registrationId }).catch(() => {}) }
  },
  async post(endpoint, body) {
    const response = await request(`/api/auth/native/${endpoint}`, body)
    return { ok: response.ok, data: await response.json() }
  },
  readSessionId: readBrowserSessionId,
  async hasSession() {
    return (await readBrowserSessionId()) !== null
  },
  navigate(path) { window.location.assign(path) },
}
