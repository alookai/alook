import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION, CommunityReadErrorSchema, requestsCommunityContract } from "@alook/shared"

export function rejectUnknownCommunityContract(request: Request): Response | null {
  const version = request.headers.get(COMMUNITY_CONTRACT_HEADER)
  return new URL(request.url).pathname.startsWith("/api/community/") && version !== null && version !== "1" && version !== String(COMMUNITY_CONTRACT_VERSION)
    ? Response.json({ error: "unsupported community contract" }, { status: 400 }) : null
}

export async function protectCommunityJsonResponse(request: Request, response: Response): Promise<Response> {
  if (!new URL(request.url).pathname.startsWith("/api/community/")) return response
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase()
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) return response
  let result = new Response(response.body, response)
  if (!response.ok && requestsCommunityContract(request.headers)) {
    const body: unknown = await result.clone().json()
    const alreadyVersioned = CommunityReadErrorSchema.safeParse(body)
    if (!alreadyVersioned.success) {
      const raw = typeof body === "object" && body !== null && "error" in body ? body.error : undefined
      const message = typeof raw === "string" ? raw : "request failed"
      const code = response.status === 401 ? "unauthenticated" : response.status === 404 ? "not_found"
        : response.status === 403 ? message === "blocked" ? "blocked" : "not_allowed"
          : response.status === 409 ? "idempotency_conflict" : response.status === 429 ? "rate_limited"
            : response.status >= 500 ? "temporarily_unavailable" : "invalid_input"
      result = new Response(JSON.stringify(CommunityReadErrorSchema.parse({ contractVersion: COMMUNITY_CONTRACT_VERSION,
        error: { code, message, retryable: response.status === 429 || response.status >= 500 } })), result)
      result.headers.delete("Content-Length")
    }
    result.headers.set(COMMUNITY_CONTRACT_HEADER, String(COMMUNITY_CONTRACT_VERSION))
  }
  result.headers.set("Cache-Control", "private, no-store, max-age=0")
  result.headers.delete("ETag")
  result.headers.delete("Last-Modified")
  const vary = result.headers.get("Vary")?.split(",").map((field) => field.trim()).filter(Boolean) ?? []
  const fields = new Set(vary.map((field) => field.toLowerCase()))
  if (!fields.has("*")) {
    const missing = [COMMUNITY_CONTRACT_HEADER, "Cookie", "Authorization"].filter((field) => !fields.has(field.toLowerCase()))
    result.headers.set("Vary", [...vary, ...missing].join(", "))
  }
  return result
}

export function varyPrivateResponseByCredentials(response: Response): Response {
  const directives = response.headers.get("Cache-Control")?.split(",") ?? []
  if (!directives.some((directive) => directive.split("=", 1)[0].trim().toLowerCase() === "private")) return response
  const vary = response.headers.get("Vary")?.split(",").map((field) => field.trim()).filter(Boolean) ?? []
  const fields = new Set(vary.map((field) => field.toLowerCase()))
  if (fields.has("*")) return response
  const missing = ["Cookie", "Authorization"].filter((field) => !fields.has(field.toLowerCase()))
  if (missing.length === 0) return response
  const result = new Response(response.body, response)
  result.headers.set("Vary", [...vary, ...missing].join(", "))
  return result
}
