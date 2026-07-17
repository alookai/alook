import { resolve } from "path"

// Playwright's config/test loader transpiles to CommonJS, so `__dirname` is
// available here (not `import.meta.dirname`).
// This file lives at src/web/src/test/e2e-ui/_setup/paths.ts.
// Six levels up reaches the monorepo root (…/alook).
export const REPO_ROOT = resolve(__dirname, "../../../../../..")
export const AUTH_DIR = resolve(__dirname, "../.auth")
export const MANIFEST_PATH = resolve(AUTH_DIR, "manifest.json")

export const WEB_URL = process.env.ALOOK_SERVER_URL || "http://localhost:3000"
export const WS_URL = process.env.DEV_WS_DO_URL || "http://localhost:8789"
