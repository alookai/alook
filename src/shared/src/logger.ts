export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

export interface LoggerOptions {
  service: string
  level?: LogLevel
  pretty?: boolean
}

export class Logger {
  private readonly service: string
  private readonly level: number
  private readonly pretty: boolean
  private readonly fields: Record<string, unknown>

  constructor(opts: LoggerOptions, fields?: Record<string, unknown>) {
    this.service = opts.service
    this.level = LEVELS[opts.level ?? "info"]
    this.pretty = opts.pretty ?? false
    this.fields = fields ?? {}
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write("debug", msg, ctx)
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write("info", msg, ctx)
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write("warn", msg, ctx)
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write("error", msg, ctx)
  }

  child(fields: Record<string, unknown>): Logger {
    const merged = { ...this.fields, ...fields }
    const child = new Logger(
      { service: this.service, level: this.levelName(), pretty: this.pretty },
      merged,
    )
    return child
  }

  private levelName(): LogLevel {
    for (const [name, num] of Object.entries(LEVELS)) {
      if (num === this.level) return name as LogLevel
    }
    return "info"
  }

  private write(
    level: Exclude<LogLevel, "silent">,
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    if (LEVELS[level] < this.level) return

    const entry: Record<string, unknown> = {
      level,
      msg,
      service: this.service,
      ...this.fields,
      ...ctx,
      ts: new Date().toISOString(),
    }

    for (const [k, v] of Object.entries(entry)) {
      if (v instanceof Error) {
        entry[k] = { message: v.message, stack: v.stack }
      }
    }

    const output: string | Record<string, unknown> = this.pretty
      ? (() => {
          const ts = (entry.ts as string).replace("T", " ").replace("Z", "")
          const lvl = (entry.level as string).toUpperCase().padEnd(5)
          const pairs = Object.entries(entry)
            .filter(([k]) => k !== "level" && k !== "msg" && k !== "service" && k !== "ts")
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join(" ")
          return `${ts} ${lvl} [${entry.service}] ${entry.msg}${pairs ? " " + pairs : ""}`
        })()
      : entry

    if (level === "error") {
      console.error(output)
    } else if (level === "warn") {
      console.warn(output)
    } else {
      console.log(output)
    }
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new Logger(opts)
}
