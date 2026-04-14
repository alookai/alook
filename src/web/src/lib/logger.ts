import { Logger, createLogger } from "@alook/shared"

export type { LogLevel, LoggerOptions } from "@alook/shared"
export { Logger, createLogger }

export const log = createLogger({
  service: "web",
  level: (process.env.ALOOK_LOG_LEVEL as "debug" | "info" | "warn" | "error" | "silent") || "info",
})
