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

export class Logger {
  private level: number;
  private color: boolean;

  constructor(level: LogLevel = "info") {
    this.level = LEVELS[level];
    this.color = useColor();
  }

  setLevel(level: LogLevel): void {
    this.level = LEVELS[level];
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

  private write(
    level: Exclude<LogLevel, "silent">,
    msg: string,
    args: unknown[],
  ): void {
    if (LEVELS[level] < this.level) return;

    const ts = timestamp();
    const label = LABELS[level];
    let line: string;

    if (this.color) {
      const c = COLORS[level];
      line = `${DIM}${ts}${RESET} ${c}${label}${RESET} ${msg}`;
    } else {
      line = `${ts} ${label} ${msg}`;
    }

    const dest = level === "error" ? process.stderr : process.stdout;
    dest.write(line + "\n");

    for (const a of args) {
      if (a instanceof Error) {
        dest.write(`  ${a.message}\n`);
      } else if (a !== undefined) {
        dest.write(`  ${String(a)}\n`);
      }
    }
  }
}

export function createLogger(level?: LogLevel): Logger {
  const envLevel = process.env.ALOOK_LOG_LEVEL as LogLevel | undefined;
  return new Logger(level ?? envLevel ?? "info");
}

export const log = createLogger();
