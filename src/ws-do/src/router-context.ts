import { createLogger, type Logger } from "@alook/shared"

export const log = createLogger({ service: "ws-do" })

export interface RouterContext {
  request: Request
  env: Env
  url: URL
  traceId: string | undefined
  log: Logger
}

export function decodePathSegment(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw)
    return decoded.length > 0 ? decoded : null
  } catch {
    return null
  }
}
