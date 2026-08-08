export async function handleRateLimit(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  // Strongly-consistent, parameterized rate limiter. Every rate-limit
  // call site (community message send, auth OTP, future policies) hits
  // this single endpoint with a `{ name, key, windowMs, max }` payload
  // — one DO instance per (name, key) pair. Policy values come from the
  // shared `RATE_LIMITS` registry in `src/shared/src/lib/rate-limits.ts`
  // so ceilings live in one place, not scattered across route handlers.
  //
  // See `rate-limit-do.ts` for the counter logic.
  if (url.pathname !== "/rate-limit/check" || request.method !== "POST") return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const { name, key, windowMs, max } = (body ?? {}) as {
    name?: unknown
    key?: unknown
    windowMs?: unknown
    max?: unknown
  }
  if (typeof name !== "string" || name.length === 0) {
    return new Response("name required", { status: 400 })
  }
  if (typeof key !== "string" || key.length === 0) {
    return new Response("key required", { status: 400 })
  }
  const doId = env.RATE_LIMIT_DO.idFromName(name + ":" + key)
  const stub = env.RATE_LIMIT_DO.get(doId)
  return stub.fetch(
    new Request("http://internal/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMs, max }),
    }),
  )
}
