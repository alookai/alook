const MAX_RETRIES = 3
const BASE_DELAY_MS = 300

export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return true

  const cause = (err as Error & { cause?: Error }).cause
  if (cause && (cause as NodeJS.ErrnoException).code === "ECONNRESET") return true
  if (cause && cause.message?.includes("other side closed")) return true

  if (err instanceof TypeError && err.message.includes("fetch failed")) return true

  return false
}

export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err: unknown) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * attempt))
        continue
      }
      throw err
    }
  }
  throw new Error("unreachable")
}
