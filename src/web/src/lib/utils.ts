import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { resolveMode, cliCommand, updateCommand, daemonCommand, isTauri, isMobile, devWsDoPort, type AlookMode } from "@alook/shared"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function getMode() {
  const tauri = typeof window !== "undefined" && isTauri();
  return resolveMode({
    nodeEnv: process.env.NODE_ENV,
    hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
    tauri,
    tauriPlatform: tauri ? (isMobile() ? "mobile" : "desktop") : undefined,
  })
}

export function getAppMode(): AlookMode {
  return getMode()
}

export function isLocalMode(): boolean {
  return getMode() !== "production"
}

// The local dev WS Durable Object port (see DEV_WS_DO_URL in @alook/shared).
// Browser-side constant shared by every hook/component that dials ws-do
// directly in local dev — keep this the single definition instead of
// re-reading NEXT_PUBLIC_WS_DO_PORT in each call site.
export const WS_DO_PORT_DEFAULT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || devWsDoPort()

export function cliCmd(): string {
  return cliCommand(getMode())
}

export function daemonStartCmd(): string {
  return daemonCommand(getMode())
}

export function updateCmd(): string {
  return updateCommand(getMode())
}
