import { parseRetryAfterSeconds } from "@/lib/retry-after"

const DEFAULT_RETRY_DELAY_MS = 400

export function isRetryableSeedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

export function seedRetryDelayMs(response: Pick<Response, "status" | "headers">): number {
  if (response.status !== 429) return DEFAULT_RETRY_DELAY_MS
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers)
  return retryAfterSeconds === null
    ? DEFAULT_RETRY_DELAY_MS
    : retryAfterSeconds * 1000
}
