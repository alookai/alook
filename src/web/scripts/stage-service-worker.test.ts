import type { createSerwistRoute } from "@serwist/turbopack"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ options: null as Record<string, unknown> | null, status: 200, type: "application/javascript", script: true }))
vi.mock("@serwist/turbopack", () => ({ createSerwistRoute: (options: Record<string, unknown>) => {
  mocks.options = options
  return { GET: async () => {
    const { readdirSync } = await import("node:fs")
    const shell = readdirSync(`${options.cwd}/public/community-shell`)[0]
    return new Response(mocks.script ? `self.shell="/community-shell/${shell}"` : "", { status: mocks.status, headers: { "Content-Type": mocks.type, "Service-Worker-Allowed": "/" } })
  } }
} }))
import { stageCommunityShell, stageServiceWorker } from "./stage-service-worker"
type RouteOptions = Parameters<typeof createSerwistRoute>[0]
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
beforeEach(() => { mocks.status = 200; mocks.type = "application/javascript"; mocks.script = true; mocks.options = null })
const html = '<html><main data-community-shell="public">Neutral</main></html>'
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "alook-public-shell-")); roots.push(root)
  mkdirSync(resolve(root, ".next/server/app"), { recursive: true }); mkdirSync(resolve(root, "public"))
  writeFileSync(resolve(root, ".next/prerender-manifest.json"), JSON.stringify({ routes: { "/c": {} } }))
  writeFileSync(resolve(root, ".next/server/app/c.html"), html)
  writeFileSync(resolve(root, "public/sw.js"), "old-worker")
  return root
}
describe("complete build shell and worker staging", () => {
  it("builds a classic worker from explicit public asset globs", async () => {
    await stageServiceWorker(fixture())
    const options = mocks.options as RouteOptions | null
    expect(options?.swSrc).toBe("src/app/sw.ts")
    expect(options?.useNativeEsbuild).toBe(true)
    expect(options?.globPatterns).toEqual([
      ".next/static/chunks/**/*.{js,css}",
      ".next/static/media/**/*.{woff,woff2,ttf,png,jpg,jpeg,webp,svg,ico}",
      ".next/static/media/pdf.worker.min.*.mjs",
      ".next/static/*/_{buildManifest,clientMiddlewareManifest,ssgManifest}.js",
      "public/**/*.{svg,png,jpg,jpeg,webp,ttf,json}",
      "public/community-shell/*",
      "src/app/favicon.ico",
    ])
    expect(options?.modifyURLPrefix).toEqual({ "src/app/favicon.ico": "/favicon.ico" })
    expect(options?.maximumFileSizeToCacheInBytes).toBe(10 * 1024 * 1024)
    expect(options?.esbuildOptions).toEqual({ format: "iife", sourcemap: false, minify: true, define: { "process.env.NODE_ENV": JSON.stringify("production") } })
  })
  it("filters private documents and unknown assets while retaining only the exact current shell", async () => {
    await stageServiceWorker(fixture())
    const options = mocks.options as RouteOptions | null
    const urls = [
      ".next/static/chunks/app-a.js",
      ".next/static/chunks/styles-a.css",
      ".next/static/media/font-a.woff2",
      ".next/static/media/pdf.worker.min.35m0adryw15hm.mjs",
      ".next/static/PGQscKRC0WsRFC5mS4zSH/_buildManifest.js",
      ".next/static/PGQscKRC0WsRFC5mS4zSH/_clientMiddlewareManifest.js",
      ".next/static/PGQscKRC0WsRFC5mS4zSH/_ssgManifest.js",
      "/favicon.ico",
      "public/manifest.json",
      "public/fonts/jgs5/jgs5.ttf",
      "public/contact/gus-photo.jpeg",
      "public/alook.svg",
      "public/official-server-badge-flat.svg",
      "public/apple-touch-icon.png",
      "public/icon-192.png",
      "public/icon-512.png",
    ]
    const publicEntries = urls.map((url, i) => ({ url, revision: `public-${i}`, size: i + 1 }))
    const excluded = [
      "public/sw.js", "public/unknown.png", "public/avatar.png",
      ".next/server/app/c.html", ".next/server/app/c.rsc",
      "/c", "/c?_rsc=private", "/api/community/users/me/profile",
      "/api/community/servers/server-a/avatar?v=1", "/api/files/private-a",
      "https://other.test/_next/static/chunks/app-a.js",
      ".next/static/chunks/app-a.js?account=a",
      ".next/static/media/other-worker.mjs",
      ".next/static/media/pdf.worker.min.mjs",
      ".next/static/PGQscKRC0WsRFC5mS4zSH/unknown.js",
      ".next/static/private/nested/_buildManifest.js",
    ].map((url, i) => ({ url, revision: `excluded-${i}`, size: i + 1 }))
    const shell = { url: `public/community-shell/${createHash("sha256").update(html).digest("hex")}`, revision: "shell" }
    excluded.push({ url: `public/community-shell/${"a".repeat(64)}`, revision: "old-shell", size: 1 })
    excluded.push({ url: `${shell.url}?account=a`, revision: "query-shell", size: 1 })
    const result = await options!.manifestTransforms![0]([...publicEntries, shell, ...excluded])
    expect(result).toEqual({ manifest: [...publicEntries, shell], warnings: [] })
    expect(result.manifest[0]).toBe(publicEntries[0])
  })

  it("publishes exact prerendered bytes at an immutable hash URL before building the worker", async () => {
    const root = fixture(); await stageServiceWorker(root)
    const hash = createHash("sha256").update(html).digest("hex")
    expect(readFileSync(resolve(root, `public/community-shell/${hash}`), "utf8")).toBe(html)
    expect(readFileSync(resolve(root, "public/sw.js"), "utf8")).toContain(`/community-shell/${hash}`)
    expect(mocks.options?.cwd).toBe(root)
  })
  it("updates the shell hash with bytes and removes only old generated shell assets", () => {
    const root = fixture(); const old = stageCommunityShell(root)
    writeFileSync(resolve(root, "public/community-shell/keep.txt"), "unowned")
    writeFileSync(resolve(root, ".next/server/app/c.html"), `${html}updated`)
    expect(stageCommunityShell(root)).not.toBe(old)
    expect(readdirSync(resolve(root, "public/community-shell"))).toContain("keep.txt")
    expect(readdirSync(resolve(root, "public/community-shell"))).not.toContain(old.split("/").at(-1))
  })
  it.each(["missing-document", "dynamic-document", "missing-marker"])("rejects %s instead of publishing a stale worker", async mode => {
    const root = fixture()
    if (mode === "missing-document") rmSync(resolve(root, ".next/server/app/c.html"))
    if (mode === "dynamic-document") writeFileSync(resolve(root, ".next/prerender-manifest.json"), JSON.stringify({ routes: {} }))
    if (mode === "missing-marker") writeFileSync(resolve(root, ".next/server/app/c.html"), "private document")
    await expect(stageServiceWorker(root)).rejects.toThrow()
    expect(readFileSync(resolve(root, "public/sw.js"), "utf8")).toBe("old-worker")
  })
  it.each(["status", "type", "empty-script"])("rejects bad worker %s before replacing the current script", async field => {
    const root = fixture()
    if (field === "status") mocks.status = 500
    if (field === "type") mocks.type = "text/html"
    if (field === "empty-script") mocks.script = false
    await expect(stageServiceWorker(root)).rejects.toThrow()
    expect(readFileSync(resolve(root, "public/sw.js"), "utf8")).toBe("old-worker")
  })
})
