import { copyFileSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function stageServiceWorker(webRoot: string): void {
  const source = resolve(webRoot, ".next/server/app/serwist/sw.js.body")
  const metadata = JSON.parse(readFileSync(resolve(webRoot, ".next/server/app/serwist/sw.js.meta"), "utf8"))
  if (metadata.status !== 200 || metadata.headers["content-type"] !== "application/javascript"
    || metadata.headers["service-worker-allowed"] !== "/" || metadata.headers["cache-control"] !== "no-cache") {
    throw new Error("Generated public service worker metadata is invalid")
  }
  mkdirSync(resolve(webRoot, "public"), { recursive: true })
  copyFileSync(source, resolve(webRoot, "public/sw.js"))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageServiceWorker(fileURLToPath(new URL("../", import.meta.url)))
}
