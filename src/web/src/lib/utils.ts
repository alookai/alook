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
    return `ALOOK_SERVER_URL=${window.location.origin} npx @alook/cli`
  }
  return "npx @alook/cli"
}
