import { expect, test } from "@playwright/test"

const PUBLIC_ORIGIN = "http://127.0.0.1:3000"

test("main and Blog navigate across Workers through one public origin", async ({ page }) => {
  const documentRequests: string[] = []
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      documentRequests.push(request.url())
    }
  })

  await page.goto("/")
  await page.locator(".hero-section").evaluate((hero) => {
    window.scrollTo(0, hero.getBoundingClientRect().bottom + window.scrollY + 1)
  })
  const blogLink = page.getByRole("link", { name: "Blog" }).first()
  await expect(blogLink).toBeVisible()
  await expect(blogLink).toHaveAttribute("href", "/blog")
  await blogLink.click()
  await expect(page).toHaveURL(`${PUBLIC_ORIGIN}/blog`)
  await expect(page.getByRole("heading", { name: "Multi-Agent Collaboration & AI Team" })).toBeVisible()
  expect(documentRequests.at(-1)).toBe(`${PUBLIC_ORIGIN}/blog`)

  const assetUrls = await page.locator('script[src], link[rel="stylesheet"]').evaluateAll((elements) => (
    elements.map((element) => (
      element instanceof HTMLScriptElement ? element.src : (element as HTMLLinkElement).href
    ))
  ))
  expect(assetUrls.some((url) => url.startsWith(`${PUBLIC_ORIGIN}/blog-static/_next/`))).toBe(true)
  expect(assetUrls.some((url) => url.startsWith(`${PUBLIC_ORIGIN}/_next/`))).toBe(false)

  const firstPost = page.locator('main a[href^="/blog/"]:not([href="/blog/feed.xml"])').first()
  const firstPostHref = await firstPost.getAttribute("href")
  await firstPost.click()
  await expect(page).toHaveURL(`${PUBLIC_ORIGIN}${firstPostHref}`)
  await expect(page.locator("article h1")).toBeVisible()

  await page.getByRole("link", { name: "Alook" }).first().click()
  await expect(page).toHaveURL(`${PUBLIC_ORIGIN}/`)
  expect(documentRequests.at(-1)).toBe(`${PUBLIC_ORIGIN}/`)
  expect(documentRequests.every((url) => new URL(url).origin === PUBLIC_ORIGIN)).toBe(true)
})

test("Blog route, OG, and root discovery ownership stay disjoint", async ({ request }) => {
  const [blogger, og, sitemap, llms] = await Promise.all([
    request.get("/blogger"),
    request.get("/og/blog/ai-agent-identity"),
    request.get("/sitemap.xml"),
    request.get("/llms.txt"),
  ])

  expect(blogger.status()).toBe(404)
  expect(og.ok()).toBe(true)
  expect(og.headers()["content-type"]).toMatch(/^image\//)
  expect(sitemap.ok()).toBe(true)
  expect(await sitemap.text()).toContain("https://alook.ai/blog/ai-agent-identity")
  expect(llms.ok()).toBe(true)
  expect(await llms.text()).toContain("## Blog posts")
})
