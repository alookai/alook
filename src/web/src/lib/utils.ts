import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { resolveMode, cliCommand, daemonCommand, type AlookMode } from "@alook/shared"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function getMode() {
  return resolveMode({
    nodeEnv: process.env.NODE_ENV,
    hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
  })
}

export function getAppMode(): AlookMode {
  return getMode()
}

export function isLocalMode(): boolean {
  return getMode() !== "production"
}

export function cliCmd(): string {
  return cliCommand(getMode())
}

export function daemonStartCmd(): string {
  return daemonCommand(getMode())
}
