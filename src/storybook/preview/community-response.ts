import { HttpResponse, type HttpResponseInit, type JsonBodyType } from "msw"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION, CommunityReadErrorSchema } from "@alook/shared"

export function communityJson<T extends JsonBodyType>(body: T, init?: HttpResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set(COMMUNITY_CONTRACT_HEADER, String(COMMUNITY_CONTRACT_VERSION))
  return HttpResponse.json(body, { ...init, headers })
}

export function communityError(code: "not_found" | "temporarily_unavailable", message: string, status: number) {
  return communityJson(CommunityReadErrorSchema.parse({ contractVersion: COMMUNITY_CONTRACT_VERSION, error: { code, message, retryable: false } }), { status })
}
