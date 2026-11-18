import { CURRENT_COMMUNITY_FIXTURE_HEADERS, currentCommunityFixtureError } from "./_fixtures/business-contract"
import { expect, test } from "./_fixtures/case-fixture"
import { tid } from "./_fixtures/testids"

test("plan Contact stays usable without billing data and preserves the plan tab", async ({ caseActors }, testInfo) => {
  const actors = await caseActors(["alice"])
  const { asUser } = actors

  for (const width of [1280, 390]) {
    const { page, context } = await asUser("alice", { viewport: { width, height: 844 } })
    const billingWrites: string[] = []
    context.on("request", (request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/community/billing")) billingWrites.push(request.url())
    })
    let releaseBilling!: () => void
    const billingGate = new Promise<void>((resolve) => { releaseBilling = resolve })
    actors.onCleanup(async () => { releaseBilling() })
    await page.route("**/api/community/billing", async (route) => {
      await billingGate
      await route.fulfill(currentCommunityFixtureError("Unavailable", 503))
    })
    await page.goto("/c/me/friends?settings=billing")
    const panel = page.getByTestId(tid.billingSheet)
    const contact = panel.getByRole("link", { name: "Contact us (opens in a new tab)" })
    await expect(contact).toBeInViewport()
    await expect(panel.getByLabel("Loading billing")).toBeVisible()
    // Keep the 44px target requirement with the agreed 1px rendered-size tolerance.
    expect((await contact.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 1)
    for (const phase of ["loading", "error"]) {
      if (phase === "error") {
        releaseBilling()
        await expect(panel.getByRole("alert")).toContainText("Couldn't refresh your plan")
      }
      await testInfo.attach(`billing-contact-${phase}-${width}`, { body: await page.screenshot(), contentType: "image/png" })
      const opened = context.waitForEvent("page")
      await contact.focus()
      await page.keyboard.press("Enter")
      const contactPage = await opened
      await expect(contactPage).toHaveURL(/\/contact$/)
      await expect(contactPage.getByRole("heading", { name: "Let’s talk." })).toBeVisible()
      expect(await contactPage.evaluate(() => window.opener)).toBeNull()
      await expect(page).toHaveURL(/\/c\/me\/friends\?settings=billing$/)
      await expect(contact).toBeVisible()
      expect(billingWrites).toEqual([])
      await contactPage.close()
    }
    await context.close()
  }
})

test("an admitted billing checkout navigates once without waiting for analytics", async ({ caseActors }) => {
  const actors = await caseActors(["alice"])
  const { page } = await actors.asUser("alice")
  const writes: unknown[] = []
  const summary = {
    plan: { id: "free", displayName: "Free" }, isFounder: false, subscription: null,
    offers: [{ priceId: "price_controlled_studio", plan: { id: "studio", displayName: "Studio" }, botLimit: 10, machineLimit: 5, unitAmount: 2000, currency: "usd", interval: "month", intervalCount: 1 }],
  }
  await page.route("**/api/community/billing", route => route.fulfill({ json: summary, headers: CURRENT_COMMUNITY_FIXTURE_HEADERS }))
  await page.route("**/api/community/billing/checkout", async route => {
    writes.push(route.request().postDataJSON())
    await route.fulfill({ json: { url: "https://checkout.stripe.com/c/pay/controlled-fixture" }, headers: CURRENT_COMMUNITY_FIXTURE_HEADERS })
  })
  await page.route("https://checkout.stripe.com/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Controlled checkout destination</title>" }))
  await page.goto("/c/me/bots?settings=billing")
  const panel = page.getByTestId(tid.billingSheet)
  await expect(panel.getByRole("button", { name: "Choose Studio", exact: true })).toBeEnabled()
  await panel.getByRole("button", { name: "Choose Studio", exact: true }).click()
  await expect(page).toHaveURL("https://checkout.stripe.com/c/pay/controlled-fixture")
  expect(writes).toEqual([{ priceId: "price_controlled_studio" }])
})
