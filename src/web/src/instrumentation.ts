const SUPPRESSED_WARNINGS = [
  "[Better Auth]:",
]

export function register() {
  if (process.env.NODE_ENV !== "development") return

  // Patch stdout.write to prepend timestamps to Next.js dev request logs.
  try {
    const proc = (globalThis as Record<string, unknown>)["process"] as typeof process | undefined
    const stdout = proc?.stdout
    if (typeof stdout?.write === "function") {
      const origWrite = stdout.write.bind(stdout)
      const REQUEST_LOG_RE = /^ +(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /

      function timestamp(): string {
        return new Date().toISOString().replace("T", " ").replace("Z", "")
      }

      stdout.write = (
        chunk: Uint8Array | string,
        ...rest: unknown[]
      ): boolean => {
        const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
        if (REQUEST_LOG_RE.test(str)) {
          return (origWrite as (chunk: Uint8Array | string, ...args: unknown[]) => boolean)(`${timestamp()}${str}`, ...rest)
        }
        return (origWrite as (chunk: Uint8Array | string, ...args: unknown[]) => boolean)(chunk, ...rest)
      }
    }
  } catch {
    // Edge Runtime — no process.stdout, skip patching
  }

  // Suppress noisy third-party warnings in dev
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : ""
    if (SUPPRESSED_WARNINGS.some((s) => first.includes(s))) return
    origWarn(...args)
  }
}
