import { DEV_WEB_URL } from "@alook/shared"
import { nanoid } from "nanoid"
import type { EmailEnv } from "./types"

export async function notifyWeb(
  env: EmailEnv, payload: Record<string, unknown>,
  options: { traceId?: string; includeResponseBody?: boolean } = {},
): Promise<void> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trace-Id": options.traceId ?? nanoid(12) },
    body: JSON.stringify(payload),
  }
  try {
    const response = await env.WEB_SERVICE.fetch("http://internal/api/email/notify", init)
    if (!response.ok) {
      const detail = options.includeResponseBody ? `: ${await response.text().catch(() => "")}` : ""
      throw new Error(`WEB_SERVICE responded ${response.status}${detail}`)
    }
  } catch (serviceError) {
    try {
      const fallback = await fetch(`${DEV_WEB_URL}/api/email/notify`, init)
      if (!fallback.ok) throw new Error(`fallback responded ${fallback.status}`)
    } catch {
      throw serviceError instanceof Error ? serviceError : new Error(String(serviceError))
    }
  }
}
