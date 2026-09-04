import { expect, test } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

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

test("desktop landing keeps the embedded phone Back control on true mobile geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")

  const stage = page.getByTestId(tid.landingMobileMotionStage)
  await stage.scrollIntoViewIfNeeded()
  const back = stage.locator('button[aria-label="Back"]')
  await expect(back).toBeVisible()
  await expect.poll(() => stage.evaluate((stageElement) => {
    const canvas = stageElement.firstElementChild
    if (!(canvas instanceof HTMLElement)) return false
    return Math.abs(canvas.getBoundingClientRect().width - stageElement.getBoundingClientRect().width) < 0.5
  })).toBe(true)

  const metrics = await stage.evaluate((stageElement) => {
    const backElement = stageElement.querySelector<HTMLElement>('button[aria-label="Back"]')
    const identityElement = stageElement.querySelector<HTMLElement>('[data-slot="message-header-identity"]')
    const canvas = stageElement.firstElementChild as HTMLElement | null
    if (!backElement || !identityElement || !canvas) return null
    const backRect = backElement.getBoundingClientRect()
    const identityRect = identityElement.getBoundingClientRect()
    const scale = canvas.getBoundingClientRect().width / canvas.offsetWidth
    return {
      backDisplay: getComputedStyle(backElement).display,
      backOffset: [backElement.offsetWidth, backElement.offsetHeight],
      backRect: [backRect.width / scale, backRect.height / scale],
      identityGap: (identityRect.left - backRect.right) / scale,
    }
  })

  expect(metrics).not.toBeNull()
  expect(metrics?.backDisplay).not.toBe("none")
  expect(metrics?.backOffset).toEqual([44, 44])
  expect(metrics?.backRect[0]).toBeCloseTo(44, 1)
  expect(metrics?.backRect[1]).toBeCloseTo(44, 1)
  expect(metrics?.identityGap).toBeCloseTo(4, 1)
})
