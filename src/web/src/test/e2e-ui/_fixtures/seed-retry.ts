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

export async function retrySeedRequest(
  request: () => Promise<Response>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => (
    new Promise((resolve) => setTimeout(resolve, delayMs))
  ),
): Promise<Response> {
  let response: Response | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await request()
    if (response.ok || !isRetryableSeedStatus(response.status)) return response
    if (attempt < 2) await wait(seedRetryDelayMs(response))
  }
  return response!
}
