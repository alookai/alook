import { createLogger, type Logger } from "@alook/shared"

export const log = createLogger({ service: "ws-do" })

export interface RouterContext {
  request: Request
  env: Env
  url: URL
  traceId: string | undefined
  log: Logger
}
