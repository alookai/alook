type SignOutLease = {
  drain: (signal?: AbortSignal) => Promise<void>
  fetch: typeof fetch
  release: () => void
}

function aborted() {
  return new DOMException("Session transport paused for sign-out", "AbortError")
}

export function createSessionTransport(nativeFetch: typeof fetch, origin: string) {
  const pending = new Set<Promise<void>>()
  let activeLease: { key: symbol; released: Promise<void>; release: () => void } | undefined
  let identityGeneration = 0
  const identities = new Set<Promise<void>>()

  function carriesSession(input: RequestInfo | URL, init?: RequestInit) {
    const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined)
    if (credentials === "omit") return false
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    return url.origin === origin && url.pathname.startsWith("/api/")
  }

  async function waitFor(promise: Promise<unknown>, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
      promise.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", onAbort))
    })
  }

  function execute(input: RequestInfo | URL, init?: RequestInit, lease?: symbol, finish?: () => void): Promise<Response> {
    if (!carriesSession(input, init)) return nativeFetch(input, init)
    if (activeLease !== undefined && activeLease.key !== lease) { finish?.(); return Promise.reject(aborted()) }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (signal?.aborted) { finish?.(); return Promise.reject(signal.reason) }
    const wire = new AbortController()
    let receivedHeaders = false
    let rejectCaller: (reason: unknown) => void = () => {}
    const onAbort = () => {
      rejectCaller(signal?.reason)
      if (receivedHeaders) wire.abort(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    let transport: Promise<Response>
    try {
      transport = nativeFetch(input, { ...init, signal: wire.signal })
    } catch (error) {
      signal?.removeEventListener("abort", onAbort)
      finish?.()
      return Promise.reject(error)
    }
    const completion = transport.then(response => {
      receivedHeaders = true
      if (signal?.aborted) wire.abort(signal.reason)
      return response
    }, error => {
      signal?.removeEventListener("abort", onAbort)
      throw error
    })
    const settled = completion.then(() => { pending.delete(settled); finish?.() }, () => { pending.delete(settled); finish?.() })
    pending.add(settled)
    return new Promise((resolve, reject) => {
      rejectCaller = reject
      if (signal?.aborted) reject(signal.reason)
      completion.then(resolve, reject)
    })
  }

  return {
    fetch: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), origin)
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const identityRequest = carriesSession(input, init) && method.toUpperCase() === "POST"
        && url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/auth/sign-out"
      const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const cancellation = () => {
        const timeout = AbortSignal.timeout(30_000)
        return originalSignal ? AbortSignal.any([originalSignal, timeout]) : timeout
      }
      if (identityRequest) {
        identityGeneration += 1
        let finish!: () => void
        const identity = new Promise<void>(resolve => { finish = resolve })
        identities.add(identity)
        const finishIdentity = () => { identities.delete(identity); finish() }
        let dispatched = false
        try {
          if (activeLease) {
            const signal = cancellation()
            do {
              if (activeLease) await waitFor(activeLease.released, signal)
              await waitFor(Promise.all([...pending]), signal)
            } while (activeLease)
            if (signal.aborted) throw signal.reason
          }
          dispatched = true
          return await execute(input, init, undefined, finishIdentity)
        } finally { if (!dispatched) finishIdentity() }
      }
      if (carriesSession(input, init) && url.pathname === "/api/auth/get-session" && identities.size) {
        await waitFor(Promise.all([...identities]), cancellation())
      }
      return execute(input, init)
    }) as typeof fetch,
    identityGeneration: () => identityGeneration,
    beginSignOut(assertActive: () => void): SignOutLease {
      assertActive()
      if (activeLease !== undefined) throw aborted()
      const lease = Symbol()
      let release!: () => void
      activeLease = { key: lease, released: new Promise<void>(resolve => { release = resolve }), release }
      const assertLease = () => {
        assertActive()
        if (activeLease?.key !== lease) throw aborted()
      }
      return {
        async drain(signal) {
          assertLease()
          const timeout = AbortSignal.timeout(10_000)
          const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(cancellation.reason)
            cancellation.addEventListener("abort", onAbort, { once: true })
            if (cancellation.aborted) onAbort()
            Promise.all([...pending]).then(() => {
              cancellation.removeEventListener("abort", onAbort)
              resolve()
            }, reject)
          })
          assertLease()
        },
        fetch: (input, init) => {
          assertLease()
          return execute(input, init, lease)
        },
        release() {
          if (activeLease?.key === lease) { activeLease.release(); activeLease = undefined }
        },
      }
    },
  }
}

let browserTransport: ReturnType<typeof createSessionTransport> | undefined

export function installSessionTransport() {
  if (browserTransport || typeof window === "undefined") return
  browserTransport = createSessionTransport(window.fetch.bind(window), window.location.origin)
  window.fetch = browserTransport.fetch
}

export function beginSessionSignOut(assertActive: () => void): SignOutLease {
  if (!browserTransport) {
    if (typeof window !== "undefined") throw new Error("Session transport is not initialized")
    return createSessionTransport(fetch, "http://localhost").beginSignOut(assertActive)
  }
  return browserTransport.beginSignOut(assertActive)
}

export function sessionIdentityGeneration() { return browserTransport?.identityGeneration() ?? 0 }

export function sessionFetch(fallback: typeof fetch): typeof fetch {
  return (input, init) => (browserTransport ? globalThis.fetch : fallback)(input, init)
}
