export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const LABELS: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

const COLORS: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "\x1b[90m",  // gray
  info: "\x1b[36m",   // cyan
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return true;
  return process.stdout.isTTY === true;
}

function timestamp(): string {
  const d = new Date();
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

export interface LoggerOptions {
  level?: LogLevel;
  module?: string;
}

export class Logger {
  private level: number;
  private color: boolean;
  private module: string | undefined;

  constructor(opts: LoggerOptions = {}) {
    const envLevel = process.env.ALOOK_LOG_LEVEL as LogLevel | undefined;
    this.level = LEVELS[opts.level ?? envLevel ?? "info"];
    this.color = useColor();
    this.module = opts.module;
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level];
  }

  child(module: string): Logger {
    const child = new Logger({ level: this.levelName(), module });
    return child;
  }

  debug(msg: string, ...args: unknown[]): void {
    this.write("debug", msg, args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.write("info", msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.write("warn", msg, args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.write("error", msg, args);
  }

  private levelName(): LogLevel {
    for (const [name, num] of Object.entries(LEVELS)) {
      if (num === this.level) return name as LogLevel;
    }
    return "info";
  }

  private write(
    level: Exclude<LogLevel, "silent">,
    msg: string,
    args: unknown[],
  ): void {
    if (LEVELS[level] < this.level) return;

    const ts = timestamp();
    const label = LABELS[level];
    const mod = this.module ? `[${this.module}]` : "";
    let line: string;

    if (this.color) {
      const c = COLORS[level];
      const modStr = mod ? ` ${BOLD}${mod}${RESET}` : "";
      line = `${DIM}${ts}${RESET} ${c}${label}${RESET}${modStr} ${msg}`;
    } else {
      const modStr = mod ? ` ${mod}` : "";
      line = `${ts} ${label}${modStr} ${msg}`;
    }

    const dest = level === "error" ? process.stderr : process.stdout;
    dest.write(line + "\n");

    for (const a of args) {
      if (a instanceof Error) {
        dest.write(`  ${a.message}\n`);
        if (a.stack && this.level <= LEVELS.debug) {
          dest.write(`  ${a.stack}\n`);
        }
      } else if (a !== null && typeof a === "object") {
        const pairs = Object.entries(a as Record<string, unknown>)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(" ");
        if (pairs) dest.write(`  ${pairs}\n`);
      } else if (a !== undefined) {
        dest.write(`  ${String(a)}\n`);
      }
    }
  }
}

export function createLogger(opts?: LoggerOptions): Logger {
  return new Logger(opts);
}

export const log = createLogger();
