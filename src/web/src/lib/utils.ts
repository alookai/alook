import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isLocalMode(): boolean {
  if (typeof window !== "undefined"
    && ["localhost", "127.0.0.1"].includes(window.location.hostname)) return true
  return process.env.NODE_ENV === "development"
}

export function cliCmd(): string {
  if (process.env.NODE_ENV === "development") return "pnpm dev:cli"
  if (typeof window !== "undefined"
    && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    return "npx @alook/app cli"
  }
  return "npx @alook/cli"
}

// --foreground is only needed in monorepo dev mode (pnpm dev:cli).
// In @alook/app mode, the daemon runs as a background process.
export function daemonStartCmd(): string {
  const base = `${cliCmd()} daemon start`
  if (process.env.NODE_ENV === "development") return `${base} --foreground`
  return base
}
