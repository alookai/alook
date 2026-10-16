import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type BrowserContext, type Page, type TestInfo } from "@playwright/test"
import { publicWorkerCacheNames, publicWorkerRuntimeCacheNames } from "../../lib/service-worker/cache-identity"
import { publicRuntimeAssetKind } from "../../lib/service-worker/public-cache"
import { expect, test } from "./_fixtures/case-fixture"
import { blogBuildIdFromScripts } from "./_fixtures/public-static-qa"

type Asset = { url: string; cacheName: string }
type Resource = Asset & { bytes: number; sha256: string; fromServiceWorker: boolean }

async function runWithCleanup(journey: () => Promise<void>, cleanup: () => Promise<void>) {
  const errors: unknown[] = []
  try { await journey() } catch (error) { errors.push(error) }
  try { await cleanup() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Public static resource journey and cleanup failed")
}

async function expectRootWorker(page: Page) {
  const root = new URL("/", page.url()).href
  const script = new URL("/sw.js", root).href
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => ({
    scope: registration.scope, script: registration.active?.scriptURL, updateViaCache: registration.updateViaCache,
  })))).toEqual([{ scope: root, script, updateViaCache: "none" }])
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(script)
}

async function publicCacheKeys(page: Page) {
  return page.evaluate(async () => {
    const result: Record<string, string[]> = {}
    for (const name of (await caches.keys()).filter(name => name.startsWith("alook-public-"))) {
      result[name] = (await (await caches.open(name)).keys()).map(request => request.url).sort()
    }
    return result
  })
}

async function readResource(page: Page, asset: Asset): Promise<Resource> {
  const received = page.waitForResponse(response => response.url() === asset.url && response.request().method() === "GET")
  const [body, response] = await Promise.all([
    page.evaluate(async url => {
      const response = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "error" })
      if (response.status !== 200) throw new Error(`Static resource returned ${response.status}: ${url}`)
      const bytes = await response.arrayBuffer()
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("")
      return { bytes: bytes.byteLength, sha256 }
    }, asset.url),
    received,
  ])
  return { ...asset, ...body, fromServiceWorker: response.fromServiceWorker() }
}

async function expectCachedBody(page: Page, resource: Resource) {
  await expect.poll(() => page.evaluate(async ({ cacheName, url }) => {
    if (!(await caches.has(cacheName))) return null
    const response = await (await caches.open(cacheName)).match(url)
    if (!response) return null
    const bytes = await response.arrayBuffer()
    return {
      bytes: bytes.byteLength,
      sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join(""),
    }
  }, resource)).toEqual({ bytes: resource.bytes, sha256: resource.sha256 })
}

async function expectOfflineResources(page: Page, context: BrowserContext, resources: Resource[]) {
  const image = resources.find(resource => resource.cacheName === publicWorkerRuntimeCacheNames().images)!
  await Promise.all([
    context.waitForEvent("requestfailed", { predicate: request => request.url() === image.url && request.serviceWorker() !== null })
      .then(request => expect(request.failure()?.errorText).toContain("ERR_INTERNET_DISCONNECTED")),
    (async () => {
      for (const resource of resources) {
        expect(await readResource(page, resource)).toEqual(resource)
        await expectCachedBody(page, resource)
      }
    })(),
  ])
}

async function warmBlogResources(page: Page): Promise<Resource[]> {
  await page.goto("/blog")
  await expect(page.getByRole("heading", { name: "Blog", exact: true })).toBeVisible()
  await expectRootWorker(page)
  await page.reload()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const observed = await page.evaluate(() => ({
    loaded: performance.getEntriesByType("resource").map(entry => entry.name),
    images: [...document.querySelectorAll("img")].map(image => image.currentSrc || image.src),
  }))
  const origin = new URL(page.url()).origin
  const select = (urls: string[], pattern: RegExp) => urls.find(value => {
    const url = new URL(value)
    return url.origin === origin && !url.search && pattern.test(url.pathname)
  })
  const names = publicWorkerRuntimeCacheNames()
  const selected = [
    { url: select(observed.loaded, /^\/blog-static\/_next\/static\/chunks\/.+\.js$/), cacheName: names.code },
    { url: select(observed.loaded, /^\/blog-static\/_next\/static\/chunks\/.+\.css$/), cacheName: names.code },
    { url: select(observed.loaded, /^\/blog-static\/_next\/static\/media\/.+\.(?:woff2?|ttf)$/), cacheName: names.fonts },
    { url: observed.images.find(value => new URL(value).origin === origin && !new URL(value).search && publicRuntimeAssetKind(new URL(value).pathname) === "images"), cacheName: names.images },
  ]
  const resources: Resource[] = []
  for (const asset of selected) {
    expect(asset.url, `Rendered Blog asset for ${asset.cacheName}`).toBeTruthy()
    const resource = await readResource(page, { ...asset, url: asset.url! })
    expect(resource.fromServiceWorker).toBe(true)
    expect(resource.bytes).toBeGreaterThan(0)
    await expectCachedBody(page, resource)
    resources.push(resource)
  }
  const buildId = blogBuildIdFromScripts(await page.locator("script").allTextContents().then(values => values.join("\n")))
  for (const name of ["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"]) {
    const asset = { url: new URL(`/blog-static/_next/static/${buildId}/${name}`, page.url()).href, cacheName: names.code }
    const response = page.waitForResponse(response => response.url() === asset.url && response.request().method() === "GET")
    const resource = await readResource(page, asset)
    const headers = (await response).headers()
    expect(headers["content-type"]).toMatch(/^(?:text|application)\/javascript(?:;|$)/)
    expect(headers["cache-control"]).toMatch(/\bpublic\b/)
    expect(headers["cache-control"]).not.toMatch(/\b(?:private|no-store|no-cache)\b/)
    expect(resource.fromServiceWorker).toBe(true)
    expect(resource.bytes).toBeGreaterThan(0)
    await expectCachedBody(page, resource)
    resources.push(resource)
  }
  return resources
}

async function attachReceipt(page: Page, testInfo: TestInfo, name: string, resources: Resource[] = []) {
  const worker = await page.evaluate(async () => {
    const response = await fetch("/sw.js", { credentials: "omit", cache: "no-store", redirect: "error" })
    if (response.status !== 200) throw new Error(`SW source returned ${response.status}`)
    const bytes = await response.arrayBuffer()
    return {
      url: response.url, bytes: bytes.byteLength,
      sha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join(""),
    }
  })
  await testInfo.attach(name, { body: JSON.stringify({ worker, resources, caches: await publicCacheKeys(page) }, null, 2), contentType: "application/json" })
  return worker
}

test.describe("production public static resource cache", () => {
  test("a first Blog visit registers the root worker and installs the added Main public resources", async ({ page }, testInfo) => {
    await page.goto("/blog")
    await expect(page.getByRole("heading", { name: "Blog", exact: true })).toBeVisible()
    await expectRootWorker(page)
    const keys = await publicCacheKeys(page)
    const paths = keys[publicWorkerCacheNames().precache]?.map(url => new URL(url).pathname) ?? []
    expect(paths).toEqual(expect.arrayContaining([
      "/favicon.ico", "/manifest.json", "/contact/gus-photo.jpeg", "/fonts/jgs5/jgs5.ttf",
      "/landing/people/alex.webp", "/landing/people/lin.webp", "/landing/people/nina.webp",
      "/landing/people/priya.webp", "/landing/people/sam.webp", "/social/readme-card-58c75311e5ba.png",
    ]))
    expect(paths.some(path => /^\/_next\/static\/media\/pdf\.worker\.min\.[a-zA-Z0-9_-]+\.mjs$/.test(path))).toBe(true)
    for (const name of ["_buildManifest.js", "_clientMiddlewareManifest.js", "_ssgManifest.js"]) expect(paths.some(path => path.startsWith("/_next/static/") && path.endsWith(`/${name}`))).toBe(true)
    for (const url of Object.values(keys).flat()) {
      const path = new URL(url).pathname
      expect(path.startsWith("/api/") || path === "/blog" || path.startsWith("/c/")).toBe(false)
    }
    await page.goto("/contact")
    const favicon = page.locator('link[rel="icon"][href^="/favicon.ico?"]').first()
    await expect(favicon).toHaveAttribute("href", /^\/favicon\.ico\?favicon\.[a-z0-9]+\.ico$/)
    const faviconURL = new URL((await favicon.getAttribute("href"))!, page.url()).href
    const faviconKey = keys[publicWorkerCacheNames().precache]?.find(url => new URL(url).pathname === "/favicon.ico")
    expect(faviconKey).toBeTruthy()
    const resource = await readResource(page, { url: faviconURL, cacheName: publicWorkerCacheNames().precache })
    expect(resource.fromServiceWorker).toBe(true)
    await expectCachedBody(page, { ...resource, url: faviconKey! })
    for (const url of [`${faviconURL}=`, `${faviconURL}&qa-query=one`, new URL(`/icon-192.png${new URL(faviconURL).search}`, page.url()).href]) {
      expect((await readResource(page, { url, cacheName: publicWorkerCacheNames().precache })).fromServiceWorker, url).toBe(false)
    }
    expect((await publicCacheKeys(page))[publicWorkerCacheNames().precache]).toEqual(keys[publicWorkerCacheNames().precache])
    await attachReceipt(page, testInfo, "blog-first-root-worker", [resource])
  })

  test("rendered Blog code, CSS, font and image stay readable offline without caching documents or query variants", async ({ page, context }, testInfo) => {
    const resources = await warmBlogResources(page)
    await attachReceipt(page, testInfo, "blog-static-online", resources)
    await runWithCleanup(async () => {
      await context.setOffline(true)
      await expectOfflineResources(page, context, resources)
      const rejected = await page.evaluate(async paths => Promise.all(paths.map(async path => {
        try { await fetch(path, { credentials: "omit", cache: "no-store" }); return false }
        catch { return true }
      })), ["/blog", "/api/auth/get-session", `${resources[0].url}?qa-query=uncached`])
      expect(rejected).toEqual([true, true, true])
    }, () => context.setOffline(false))
    await attachReceipt(page, testInfo, "blog-static-after-offline", resources)
  })

  test("public runtime bytes survive a browser-process restart in the same isolated profile", async ({ caseResources, baseURL, browserName }, testInfo) => {
    expect(browserName).toBe("chromium")
    expect(baseURL).toBeTruthy()
    const deadline = Date.now() + testInfo.timeout
    const launches: Array<{ close: () => Promise<void> }> = []
    const profile = caseResources.own({ directory: undefined as string | undefined }, async state => {
      const closed = await Promise.allSettled(launches.map(launch => launch.close()))
      const failures = closed.filter(result => result.status === "rejected").map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, "Persistent browser cleanup failed; profile retained")
      if (state.directory) await rm(state.directory, { recursive: true, force: true })
    })
    await runWithCleanup(async () => {
      const directory = profile.value.directory = mkdtempSync(join(tmpdir(), "alook-public-static-222-"))
      const launch = () => {
        const owner = caseResources.own({ pending: undefined as Promise<BrowserContext> | undefined }, async state => {
          if (state.pending) await (await state.pending).close()
        })
        launches.push(owner)
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error("Persistent browser launch exceeded the original test budget")
        owner.value.pending = chromium.launchPersistentContext(directory, { baseURL, headless: true, timeout: remaining })
        return { context: owner.value.pending, close: owner.close }
      }
      const first = launch()
      const firstContext = await first.context
      const firstPage = firstContext.pages()[0] ?? await firstContext.newPage()
      const resources = await warmBlogResources(firstPage)
      const before = await attachReceipt(firstPage, testInfo, "before-process-restart", resources)
      await first.close()
      const second = launch()
      const secondContext = await second.context
      const page = secondContext.pages()[0] ?? await secondContext.newPage()
      await page.goto("/robots.txt")
      await expectRootWorker(page)
      expect(await page.evaluate(() => performance.getEntriesByType("resource").some(entry => /\/(?:blog-static\/_next\/static|blog\/[^/]+\/)/.test(new URL(entry.name).pathname)))).toBe(false)
      await runWithCleanup(async () => {
        await secondContext.setOffline(true)
        await expectOfflineResources(page, secondContext, resources)
      }, () => secondContext.setOffline(false))
      const after = await attachReceipt(page, testInfo, "after-process-restart", resources)
      expect(after).toEqual(before)
      await second.close()
    }, () => profile.close())
  })
})
