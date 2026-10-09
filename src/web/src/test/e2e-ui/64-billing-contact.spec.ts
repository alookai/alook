import { expect, test } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

test("plan Contact stays usable without billing data and preserves the plan tab", async ({ asUser }, testInfo) => {
  for (const width of [1280, 390]) {
    const { page, context } = await asUser("alice", { viewport: { width, height: 844 } })
    const billingWrites: string[] = []
    context.on("request", (request) => {
      if (request.method() !== "GET" && new URL(request.url()).pathname.startsWith("/api/community/billing")) billingWrites.push(request.url())
    })
    let releaseBilling!: () => void
    const billingGate = new Promise<void>((resolve) => { releaseBilling = resolve })
    await page.route("**/api/community/billing", async (route) => {
      await billingGate
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) })
    })
    await page.goto("/c/me/friends?settings=billing")
    const panel = page.getByTestId(tid.billingSheet)
    const contact = panel.getByRole("link", { name: "Contact us (opens in a new tab)" })
    await expect(contact).toBeInViewport()
    await expect(panel.getByLabel("Loading billing")).toBeVisible()
    expect((await contact.boundingBox())!.height).toBeGreaterThanOrEqual(44)
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
