import { createSerwistRoute } from "@serwist/turbopack"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isPublicAssetPath } from "../src/lib/service-worker/public-cache"
import { communityShellDirectory, communityShellHash } from "../src/lib/service-worker/community-shell"

export function stageCommunityShell(webRoot: string): string {
  const prerender = JSON.parse(readFileSync(resolve(webRoot, ".next/prerender-manifest.json"), "utf8")) as { routes: Record<string, unknown> }
  if (!Object.hasOwn(prerender.routes, "/c")) throw new Error("Community shell must be prerendered without request data")
  const html = readFileSync(resolve(webRoot, ".next/server/app/c.html"))
  if (!html.includes('data-community-shell="public"')) throw new Error("Generated community shell marker is missing")
  const hash = createHash("sha256").update(html).digest("hex")
  const filename = hash
  const directory = resolve(webRoot, `public${communityShellDirectory}`)
  mkdirSync(directory, { recursive: true })
  for (const old of readdirSync(directory)) {
    if (communityShellHash(`${communityShellDirectory}${old}`)) rmSync(resolve(directory, old))
  }
  writeFileSync(resolve(directory, filename), html)
  return `${communityShellDirectory}${filename}`
}

export async function stageServiceWorker(webRoot: string): Promise<void> {
  const shellUrl = stageCommunityShell(webRoot)
  const serviceWorker = createSerwistRoute({
    cwd: webRoot,
    swSrc: "src/app/sw.ts",
    useNativeEsbuild: true,
    globPatterns: [
      ".next/static/chunks/**/*.{js,css}",
      ".next/static/media/**/*.{woff,woff2,ttf,png,jpg,jpeg,webp,svg,ico}",
      ".next/static/media/pdf.worker.min.*.mjs",
      ".next/static/*/_{buildManifest,clientMiddlewareManifest,ssgManifest}.js",
      "public/**/*.{svg,png,jpg,jpeg,webp,ttf,json}",
      "public/community-shell/*",
      "src/app/favicon.ico",
    ],
    modifyURLPrefix: { "src/app/favicon.ico": "/favicon.ico" },
    maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
    manifestTransforms: [async entries => ({
      manifest: entries.filter(entry => {
        const pathname = entry.url.replace(/^\.next\//, "/_next/").replace(/^public\//, "/")
        return pathname === shellUrl || isPublicAssetPath(pathname)
      }),
      warnings: [],
    })],
    esbuildOptions: { format: "iife", sourcemap: false, minify: true, define: { "process.env.NODE_ENV": JSON.stringify("production") } },
  })
  const response = await serviceWorker.GET(new Request("https://build.invalid/sw.js"), { params: Promise.resolve({ path: "sw.js" }) })
  if (response.status !== 200 || response.headers.get("Content-Type") !== "application/javascript"
    || response.headers.get("Service-Worker-Allowed") !== "/") throw new Error("Generated public service worker metadata is invalid")
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || !bytes.includes(shellUrl)) throw new Error("Generated service worker is missing the current community shell")
  writeFileSync(resolve(webRoot, "public/sw.js"), bytes)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void stageServiceWorker(fileURLToPath(new URL("../", import.meta.url))).catch(error => { console.error(error); process.exitCode = 1 })
}
