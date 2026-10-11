import type { Locator, Page } from "@playwright/test"
import { expect, test } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

async function allowAnalytics(page: Page) {
  const banner = page.getByTestId(tid.analyticsConsentBanner)
  await expect(banner).toBeVisible()
  const before = await page.evaluate(() => performance.timeOrigin)
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/privacy/analytics-consent" && response.request().method() === "POST"),
    banner.getByTestId(tid.analyticsConsentAllow).click(),
  ])
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ decision: "granted" })
  await expect(banner).toHaveCount(0)
  expect((await page.context().cookies()).find(cookie => cookie.name === "alook_analytics_consent")?.value).toBe("v1.granted")
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before)
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
  expect(new URL(request.url()).pathname).toBe(pathname)
  await expect(page).toHaveURL(url => url.pathname === pathname || pathname === "/c/me" && url.pathname.startsWith("/c/me/"))
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(before)
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(0)
}

test("first Allow retains the document and public Pricing navigation remains client-side", async ({ page }) => {
  await page.goto("/")
  await allowAnalytics(page)
  const before = await page.evaluate(() => performance.timeOrigin)
  await page.getByTestId(tid.landingFooterNavigation).getByRole("link", { name: "Pricing", exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname === "/pricing")
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before)
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(1)
})

test("a saved withdrawal replaces the public document once with the actual denied Cookie", async ({ page }) => {
  await page.goto("/")
  await allowAnalytics(page)
  await page.goto("/privacy#analytics-choices")
  const control = page.getByTestId(tid.analyticsPreferenceControl)
  await expect(control).toContainText("Analytics cookies allowed")
  const before = await page.evaluate(() => performance.timeOrigin)
  const documents: string[] = []
  page.on("request", request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.resourceType() === "document") documents.push(request.url())
  })
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/privacy/analytics-consent" && response.request().method() === "POST"),
    page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() }),
    control.getByTestId(tid.analyticsConsentNecessary).click(),
  ])
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ decision: "denied" })
  await expect(control).toContainText("Analytics cookies denied")
  expect((await page.context().cookies()).find(cookie => cookie.name === "alook_analytics_consent")?.value).toBe("v1.denied")
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(before)
  expect(documents).toHaveLength(1)
  await expect(page).toHaveURL(url => url.pathname === "/privacy" && url.hash === "#analytics-choices")
  await expect(page.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(0)
})

for (const signedIn of [false, true]) {
  test(`Home private entries replace the public document for signed-in=${signedIn}`, async ({ page: guest, asUser }) => {
    test.slow()
    const page = signedIn ? (await asUser("alice")).page : guest
    await page.goto("/")
    await allowAnalytics(page)
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
    await page.goto("/")
    await allowAnalytics(page)
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
  await allowAnalytics(page)
  const before = await page.evaluate(() => performance.timeOrigin)
  const opened = context.waitForEvent("page")
  await page.locator('.hero-ctas a[href="/sign-in"]').click({ modifiers: ["ControlOrMeta"] })
  const privatePage = await opened
  await expect(privatePage).toHaveURL(url => url.pathname === "/sign-in")
  await expect(privatePage.getByTestId(tid.ahrefsAnalyticsFrame)).toHaveCount(0)
  await expect(page).toHaveURL(url => url.pathname === "/")
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before)
  await privatePage.close()
})
