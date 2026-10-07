import { beforeEach, describe, expect, it, vi } from "vitest"
import type { createSerwistRoute } from "@serwist/turbopack"

const mocks = vi.hoisted(() => ({
  createRoute: vi.fn(),
  generateStaticParams: vi.fn(),
  GET: vi.fn(),
}))
vi.mock("@serwist/turbopack", () => ({ createSerwistRoute: mocks.createRoute }))

type RouteOptions = Parameters<typeof createSerwistRoute>[0]

async function loadRoute() {
  const route = await import("./route")
  const options = mocks.createRoute.mock.calls[0][0] as RouteOptions
  return { route, options }
}

describe("public service worker route", () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.createRoute.mockReset().mockReturnValue({
      generateStaticParams: mocks.generateStaticParams,
      GET: mocks.GET,
    })
    mocks.generateStaticParams.mockReset()
    mocks.GET.mockReset()
  })

  it("builds a classic worker from only explicit public asset globs", async () => {
    const { options } = await loadRoute()
    expect(options.swSrc).toBe("src/app/sw.ts")
    expect(options.useNativeEsbuild).toBe(true)
    expect(options.globPatterns).toEqual([
      ".next/static/chunks/**/*.{js,css}",
      ".next/static/media/*.{woff,woff2}",
      "public/alook.svg",
      "public/official-server-badge-flat.svg",
      "public/apple-touch-icon.png",
      "public/icon-192.png",
      "public/icon-512.png",
    ])
    expect(options.maximumFileSizeToCacheInBytes).toBe(10 * 1024 * 1024)
    expect(options.esbuildOptions).toEqual({
      format: "iife", sourcemap: false,
      define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV) },
    })
  })

  it("filters the generated manifest without adding account or unknown assets", async () => {
    const { options } = await loadRoute()
    const urls = [
      ".next/static/chunks/app-a.js",
      ".next/static/chunks/styles-a.css",
      ".next/static/media/font-a.woff2",
      "public/alook.svg",
      "public/official-server-badge-flat.svg",
      "public/apple-touch-icon.png",
      "public/icon-192.png",
      "public/icon-512.png",
    ]
    const publicEntries = urls.map((url, i) => ({ url, revision: `public-${i}` }))
    const excluded = [
      "public/sw.js", "public/unknown.png", "public/avatar.png",
      ".next/server/app/c.html", ".next/server/app/c.rsc",
      "/c", "/c?_rsc=private", "/api/community/users/me/profile",
      "/api/community/servers/server-a/avatar?v=1", "/api/files/private-a",
      "https://other.test/_next/static/chunks/app-a.js",
      ".next/static/chunks/app-a.js?account=a",
    ].map((url, i) => ({ url, revision: `excluded-${i}` }))
    const transform = options.manifestTransforms![0]
    const result = await transform([...publicEntries, ...excluded])
    expect(result).toEqual({ manifest: publicEntries, warnings: [] })
    expect(result.manifest[0]).toBe(publicEntries[0])
  })

  it("retains generated static params and route restrictions", async () => {
    const { route } = await loadRoute()
    const params = [{ path: "sw.js" }]
    mocks.generateStaticParams.mockResolvedValue(params)
    expect(route.generateStaticParams).toBe(mocks.generateStaticParams)
    expect(await route.generateStaticParams()).toBe(params)
    expect(route.dynamic).toBe("force-static")
    expect(route.dynamicParams).toBe(false)
    expect(route.revalidate).toBe(false)
  })

  it("preserves generated worker bytes and root scope with revalidation headers", async () => {
    const { route } = await loadRoute()
    const request = new Request("https://alook.test/serwist/sw.js")
    const context = { params: Promise.resolve({ path: "sw.js" }) }
    const generated = new Response("self.__SW_PUBLIC_TEST = true", {
      headers: { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/", "Cache-Control": "public, max-age=3600" },
    })
    mocks.GET.mockResolvedValue(generated)
    const response = await route.GET(request, context)
    expect(mocks.GET).toHaveBeenCalledWith(request, context)
    expect(response).toBe(generated)
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("application/javascript")
    expect(response.headers.get("Service-Worker-Allowed")).toBe("/")
    expect(response.headers.get("Cache-Control")).toBe("no-cache")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(await response.text()).toBe("self.__SW_PUBLIC_TEST = true")
  })

  it("propagates generated route failures without a successful worker substitute", async () => {
    const { route } = await loadRoute()
    const error = new Error("worker generation failed")
    mocks.GET.mockRejectedValue(error)
    await expect(route.GET(new Request("https://alook.test/serwist/sw.js"), {
      params: Promise.resolve({ path: "sw.js" }),
    })).rejects.toBe(error)
  })
})
