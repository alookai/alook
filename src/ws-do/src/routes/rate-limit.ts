export async function handleRateLimit(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {

  const automation = url.pathname === "/rate-limit/automation"
  if ((!automation && url.pathname !== "/rate-limit/check") || request.method !== "POST") return null

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const { name, key, windowMs, max, period } = (body ?? {}) as {
    name?: unknown
    key?: unknown
    windowMs?: unknown
    max?: unknown
    period?: unknown
  }
  if (typeof name !== "string" || name.length === 0) {
    return new Response("name required", { status: 400 })
  }
  if (typeof key !== "string" || key.length === 0) {
    return new Response("key required", { status: 400 })
  }
  const doId = env.RATE_LIMIT_DO.idFromName((automation ? "automation:" : "") + name + ":" + key)
  const stub = env.RATE_LIMIT_DO.get(doId)
  return stub.fetch(
    new Request(automation ? "http://internal/check-automation" : "http://internal/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(automation ? { period, max } : { windowMs, max }),
    }),
  )
}
