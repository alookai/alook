import type { APIResponse, Locator, Page, Request, Route } from "@playwright/test"
import { expect, test } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

async function expectDefaultAnalytics(page: Page) {
  await expect(page.getByTestId(tid.analyticsConsentBanner)).toHaveCount(0)
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(1)
  await expect.poll(async () => (await page.context().cookies()).find(cookie => cookie.name === "alook_analytics_consent")?.value).toBe("v1.granted")
}

async function savePrivacyChoice(page: Page, decision: "granted" | "denied", previousDecision: "granted" | "denied" = "granted") {
  const control = page.getByTestId(tid.analyticsPreferenceControl)
  await expect(control).toContainText(previousDecision === "granted" ? "Analytics cookies allowed" : "Analytics cookies denied")
  expect((await page.context().cookies()).find(cookie => cookie.name === "alook_analytics_consent")?.value).toBe(`v1.${previousDecision}`)
  await expect(page.getByTestId(tid.analyticsConsentBanner)).toHaveCount(0)
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(previousDecision === "granted" ? 1 : 0)
  const before = await page.evaluate(() => ({
    timeOrigin: performance.timeOrigin, url: location.href, historyLength: history.length,
  }))
  const documents: string[] = []
  const consentUrl = new URL("/api/privacy/analytics-consent", before.url).href
  let saves = 0
  let forwards = 0
  const recordRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.resourceType() === "document") documents.push(request.url())
    if (request.url() === consentUrl && request.method() === "POST") saves++
  }
  const originalResponses: APIResponse[] = []
  let resolveConsent!: (response: { status: number; body: Buffer; headers: Record<string, string> }) => void
  let rejectConsent!: (error: unknown) => void
  const consentResponse = new Promise<{ status: number; body: Buffer; headers: Record<string, string> }>((resolve, reject) => {
    resolveConsent = resolve
    rejectConsent = reject
  })
  const captureConsent = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return }
    expect(route.request().postDataJSON()).toEqual({ decision })
    forwards++
    try {
      const originalResponse = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      originalResponses.push(originalResponse)
      const body = await originalResponse.body()
      const status = originalResponse.status()
      const headers = originalResponse.headers()
      await route.fulfill({ response: originalResponse, body })
      resolveConsent({ status, body, headers })
    } catch (error) {
      rejectConsent(error)
      throw error
    }
  }
  page.on("request", recordRequest)
  await page.route(consentUrl, captureConsent)
  try {
    const [response, browserResponse, documentRequest] = await Promise.all([
      consentResponse,
      page.waitForResponse(response => response.url() === consentUrl && response.request().method() === "POST"),
      page.waitForRequest(request => request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()),
      page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() }),
      control.getByTestId(decision === "granted" ? tid.analyticsConsentAllow : tid.analyticsConsentNecessary).click(),
    ])
    await page.waitForLoadState("domcontentloaded")
    expect(response.status).toBe(200)
    expect(browserResponse.status()).toBe(response.status)
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ decision })
    expect(response.headers["set-cookie"]).toContain(`alook_analytics_consent=v1.${decision}`)
    expect(saves).toBe(1)
    expect(forwards).toBe(1)
    await expect(control).toContainText(decision === "granted" ? "Analytics cookies allowed" : "Analytics cookies denied")
    expect((await page.context().cookies()).find(cookie => cookie.name === "alook_analytics_consent")?.value).toBe(`v1.${decision}`)
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(before.timeOrigin)
    expect(await page.evaluate(() => history.length)).toBe(before.historyLength)
    const requestedUrl = new URL(before.url)
    requestedUrl.hash = ""
    expect(documentRequest.url()).toBe(requestedUrl.href)
    expect(documents).toHaveLength(1)
    await expect(page).toHaveURL(before.url)
    await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(decision === "granted" ? 1 : 0)
  } finally {
    page.off("request", recordRequest)
    await page.unroute(consentUrl, captureConsent)
    await Promise.all(originalResponses.map(response => response.dispose()))
  }
}

async function expectNativeEntry(page: Page, link: Locator, pathname: string, keyboard = false) {
  const before = await page.evaluate(() => performance.timeOrigin)
  const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() })
  const documentRequest = page.waitForRequest(request => request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame())
  if (keyboard) {
    await link.focus()
    await page.keyboard.press("Enter")
  } else await link.click()
  const [, request] = await Promise.all([navigation, documentRequest])
  await page.waitForLoadState("domcontentloaded")
  expect(new URL(request.url()).pathname).toBe(pathname)
  await expect(page).toHaveURL(url => url.pathname === pathname || pathname === "/c/me" && url.pathname.startsWith("/c/me/"))
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(before)
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(0)
}

test("public default grant has no banner, Pricing stays client-side, and Privacy can save a grant", async ({ page }) => {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/privacy/analytics-consent" && response.request().method() === "POST"),
    page.goto("/"),
  ])
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ decision: "granted" })
  expect(await response.json()).toMatchObject({ decision: "granted" })
  await expectDefaultAnalytics(page)
  const before = await page.evaluate(() => performance.timeOrigin)
  await page.getByTestId(tid.landingFooterNavigation).getByRole("link", { name: "Pricing", exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname === "/pricing")
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before)
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(1)
  await page.goto("/privacy?qa=grant#analytics-choices")
  await savePrivacyChoice(page, "granted")
})

test("a saved withdrawal replaces the public document once with the actual denied Cookie", async ({ page }) => {
  await page.goto("/")
  await expectDefaultAnalytics(page)
  await page.goto("/privacy?qa=consent#analytics-choices")
  await savePrivacyChoice(page, "denied")
})

for (const signedIn of [false, true]) {
  test(`Home private entries replace the public document for signed-in=${signedIn}`, async ({ page: guest, asUser }) => {
    test.slow()
    const page = signedIn ? (await asUser("alice")).page : guest
    if (signedIn) {
      await page.goto("/privacy?qa=entry#analytics-choices")
      await savePrivacyChoice(page, "granted", "denied")
    }
    await page.goto("/")
    await expectDefaultAnalytics(page)
    const destination = signedIn ? "/c/me" : "/sign-in"
    for (const section of ["hero", "nav", "product", "identity", "continuity", "reach", "ownership", "closing"]) {
      await page.goto("/")
      let link: Locator
      if (section === "hero") link = page.locator(`.hero-ctas a[href="${destination}"]`)
      else if (section === "nav") {
        await page.locator(".hero-section").evaluate(hero => window.scrollTo(0, hero.getBoundingClientRect().bottom + window.scrollY + 1))
        link = page.locator(`.marketing-nav a[href="${destination}"]`)
      } else link = page.getByTestId(section === "closing" ? "landing-closing-open" : `landing-section-cta-${section}`)
      await expect(link).toHaveAttribute("href", destination)
      await expectNativeEntry(page, link, destination, section === "closing")
    }
  })

  test(`Templates and Pricing private entries use document navigation for signed-in=${signedIn}`, async ({ page: guest, asUser }) => {
    test.slow()
    const page = signedIn ? (await asUser("alice")).page : guest
    const destination = signedIn ? "/c/me" : "/sign-in"
    if (signedIn) {
      await page.goto("/privacy?qa=entry#analytics-choices")
      await savePrivacyChoice(page, "granted", "denied")
    }
    await page.goto("/")
    await expectDefaultAnalytics(page)
    await page.goto("/templates")
    const templateHref = await page.locator('main a[href^="/templates/"]').first().getAttribute("href")
    expect(templateHref).toBeTruthy()
    for (const route of ["/templates", templateHref!]) {
      await page.goto(route)
      const entry = page.locator(`a[href="${destination}"]`)
      await expect(entry).toHaveCount(1)
      await expectNativeEntry(page, entry, destination)
    }
    await page.goto("/pricing")
    const action = page.getByRole("button", { name: signedIn ? "Open Alook" : "Start free", exact: true })
    await expect(action).toBeEnabled()
    await expectNativeEntry(page, action, signedIn ? "/c/me/bots" : "/sign-in", true)
    if (!signedIn) expect(new URL(page.url()).searchParams.get("redirect")).toBe("/c/me/bots")
  })
}

test("a modified private link opens another document and leaves the public tab intact", async ({ page, context }) => {
  await page.goto("/")
  await expectDefaultAnalytics(page)
  const before = await page.evaluate(() => performance.timeOrigin)
  const opened = context.waitForEvent("page")
  await page.locator('.hero-ctas a[href="/sign-in"]').click({ modifiers: ["ControlOrMeta"] })
  const privatePage = await opened
  await expect(privatePage).toHaveURL(url => url.pathname === "/sign-in")
  await privatePage.waitForLoadState("domcontentloaded")
  await expect(privatePage.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(0)
  await expect(page).toHaveURL(url => url.pathname === "/")
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before)
  await privatePage.close()
})
