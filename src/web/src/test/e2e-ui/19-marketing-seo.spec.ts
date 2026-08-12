import { expect, test } from "@playwright/test"

test("homepage SSR keeps product demos out of the heading tree", async ({ page, request }) => {
  const response = await request.get("/")

  expect(response.ok()).toBe(true)
  const counts = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html")
    return {
      h1: document.querySelectorAll("h1").length,
      demoHeadings: document.querySelectorAll('[role="img"] :is(h1, h2, h3, h4, h5, h6)').length,
    }
  }, await response.text())

  expect(counts).toEqual({ h1: 1, demoHeadings: 0 })
})
