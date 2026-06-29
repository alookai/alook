/**
 * Tiny structured logger for the daemon + local stack.
 *
 * One consistent line shape so logs are scannable and greppable:
 *
 *   2026-06-25T12:33:00.123Z @alook/daemon INFO  control plane OPEN
 *   <ISO-8601 timestamp>      <header>   <LEVEL> <message>
 *
 * - `header` defaults to `@alook/daemon` (the package), overridable per component
 *   (e.g. a sub-tag like `@alook/daemon:daemon`) so a line still says where it came
 *   from without each call site hand-prefixing `[daemon]`.
 * - Default level is `info`; `debug` lines are suppressed unless the level is
 *   lowered. `warn`/`error` go to stderr, `info`/`debug` to stdout.
 *
 * Deliberately dependency-free and minimal — not a logging framework.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Derive a logger with a sub-tagged header (e.g. `@alook/daemon:daemon`). */
  child(tag: string): Logger;
}

export interface LoggerOptions {
  /** Line header. Defaults to `@alook/daemon`. */
  header?: string;
  /** Minimum level emitted. Defaults to `info`. */
  level?: LogLevel;
  /** Injectable clock (ISO string). Defaults to the real wall clock. */
  now?: () => string;
  /** Injectable sinks (tests). Default stdout/stderr. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const DEFAULT_HEADER = "@alook/daemon";

export function createLogger(options: LoggerOptions = {}): Logger {
  const header = options.header ?? DEFAULT_HEADER;
  const minRank = LEVEL_RANK[options.level ?? "info"];
  const now = options.now ?? (() => new Date().toISOString());
  const out = options.out ?? ((line) => process.stdout.write(line + "\n"));
  const err = options.err ?? ((line) => process.stderr.write(line + "\n"));

  const emit = (level: LogLevel, message: string): void => {
    if (LEVEL_RANK[level] < minRank) return;
    // Pad the level to keep messages column-aligned (INFO/WARN are 4, ERROR/DEBUG 5).
    const line = `${now()} ${header} ${level.toUpperCase().padEnd(5)} ${message}`;
    (level === "warn" || level === "error" ? err : out)(line);
  };

  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    child: (tag) => createLogger({ ...options, header: `${header}:${tag}` }),
  };
}
