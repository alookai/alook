import { resolve } from "path"

// Playwright's config/test loader transpiles to CommonJS, so `__dirname` is
// available here (not `import.meta.dirname`).
// This file lives at src/web/src/test/e2e-ui/_setup/paths.ts.
// Six levels up reaches the monorepo root (…/alook).
export const REPO_ROOT = resolve(__dirname, "../../../../../..")
export const AUTH_DIR = resolve(__dirname, "../.auth")
export const MANIFEST_PATH = resolve(AUTH_DIR, "manifest.json")
export const SERVICE_LOG_DIR = resolve(REPO_ROOT, "src/web/e2e-service-logs")
export const SERVICE_STATE_PATH = resolve(AUTH_DIR, "service-state.json")
export const SERVICE_FAILURE_CLAIM_PATH = resolve(AUTH_DIR, "service-failure-claimed")

export const WEB_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"

export function resolveWsUrl({
  webUrl,
  explicitWsUrl,
  singleRuntime,
}: {
  webUrl: string
  explicitWsUrl?: string
  singleRuntime: boolean
}): string {
  if (explicitWsUrl) return explicitWsUrl
  return singleRuntime ? webUrl : "http://localhost:8789"
}

export function resolveMachineWsUrl({
  wsUrl,
  singleRuntime,
}: {
  wsUrl: string
  singleRuntime: boolean
}): string {
  const baseUrl = wsUrl.replace(/\/$/, "")
  return singleRuntime ? `${baseUrl}/api/ws/community-machine` : baseUrl
}

export const WS_URL = resolveWsUrl({
  webUrl: WEB_URL,
  explicitWsUrl: process.env.DEV_WS_DO_URL,
  singleRuntime: !!process.env.CI,
})

export const MACHINE_WS_URL = resolveMachineWsUrl({
  wsUrl: WS_URL,
  singleRuntime: !!process.env.CI,
})
