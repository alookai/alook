import { settings } from "../src/config"
import type { Manifest } from "../src/contracts"
import { parseUpload } from "../src/upload"

export const operatorEnv = {
  CF_ACCOUNT_ID: "00000000000000000000000000000000", CF_NAMESPACE: "test", BASE_DOMAIN: "alook.page",
  PAGE_CPU_MS: "1000", PAGE_SUBREQUESTS: "100", UPLOAD_MAX_BYTES: "16777216", FILE_MAX_BYTES: "8388608",
  UPLOAD_MAX_FILES: "128", CF_TIMEOUT_MS: "30000", RESERVED_EXACT: "", RESERVED_PREFIXES: "",
  SENSITIVE_EXACT: "", SENSITIVE_PREFIXES: "", PAGES_API_TOKEN: "test-token",
}
export const config = settings(operatorEnv)

export function manifest(prefix?: string): Manifest {
  return {
    ...(prefix === undefined ? {} : { prefix }), compatibilityDate: "2026-10-28", compatibilityFlags: [], variables: {},
    files: [{ role: "asset", part: "index", path: "/index.html", type: "text/html" }],
  }
}

export function upload(value: unknown = manifest("hello"), parts: Record<string, Blob | string> = { index: new Blob(["<h1>Hello</h1>"]) }): Request {
  const form = new FormData()
  form.append("manifest", JSON.stringify(value))
  for (const [name, blob] of Object.entries(parts)) form.append(name, blob)
  return new Request("https://private.invalid/", { method: "POST", body: form })
}

export async function artifact(prefix?: string) { return parseUpload(upload(manifest(prefix)), config) }
