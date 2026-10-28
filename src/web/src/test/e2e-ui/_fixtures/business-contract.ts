import { BUSINESS_SCHEMA_VERSION } from "../../../../../shared/src/business-schema-version"
import { COMMUNITY_CONTRACT_HEADER } from "../../../../../shared/src/community-contract"

export function assertCurrentCommunityFixtureResponse(response: Response) {
  if (response.headers.get(COMMUNITY_CONTRACT_HEADER) !== String(BUSINESS_SCHEMA_VERSION)) {
    throw new Error(`Fixture response did not confirm current business version ${BUSINESS_SCHEMA_VERSION}`)
  }
}

export async function communityFixtureFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input)
  if (!url.pathname.startsWith("/api/community/")) throw new Error("Community fixture request requires a community route")
  const headers = new Headers(init?.headers)
  headers.set(COMMUNITY_CONTRACT_HEADER, String(BUSINESS_SCHEMA_VERSION))
  const response = await fetch(input, { ...init, headers })
  if (response.ok) assertCurrentCommunityFixtureResponse(response)
  return response
}

export const CURRENT_COMMUNITY_FIXTURE_HEADERS = { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) }

export async function confirmCommunityFixtureApiResponse<T extends { ok(): boolean; headers(): Record<string, string> }>(pending: Promise<T>): Promise<T> {
  const response = await pending
  if (response.ok() && Object.entries(response.headers()).find(([name]) => name.toLowerCase() === COMMUNITY_CONTRACT_HEADER.toLowerCase())?.[1] !== String(BUSINESS_SCHEMA_VERSION)) throw new Error("Fixture API response did not confirm current business version")
  return response
}

export function currentCommunityFixtureError(message: string, status: number) {
  const code = status === 401 ? "unauthenticated" : status === 403 ? "not_allowed" : status === 404 ? "not_found" : status === 409 ? "idempotency_conflict" : status === 429 ? "rate_limited" : status >= 500 ? "temporarily_unavailable" : "invalid_input"
  return { status, headers: CURRENT_COMMUNITY_FIXTURE_HEADERS, contentType: "application/json", body: JSON.stringify({ contractVersion: BUSINESS_SCHEMA_VERSION, error: { code, message, retryable: status === 429 || status >= 500 } }) }
}
