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

test("homepage header, body, and footer share responsive content edges", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")

  for (const viewport of [
    { width: 1440, height: 900, stacked: false },
    { width: 768, height: 900, stacked: false },
    { width: 390, height: 844, stacked: true },
  ]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => new Promise<void>((resolveValue) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolveValue()))
    }))

    const rect = async (testId: string) => page.getByTestId(testId).evaluate((element) => {
      const box = element.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      }
    })
    const socialTargets = await page
      .getByTestId(tid.landingFooterSocial)
      .locator("a")
      .evaluateAll((elements) => elements.map((element) => {
        const box = element.getBoundingClientRect()
        return { width: box.width, height: box.height }
      }))
    const geometry = {
      header: await rect(tid.landingHeaderContainer),
      main: await rect(tid.landingMainContainer),
      footer: await rect(tid.landingFooterContainer),
      brand: await rect(tid.landingFooterBrand),
      navigation: await rect(tid.landingFooterNavigation),
      social: await rect(tid.landingFooterSocial),
      socialTargets,
      documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    }

    for (const surface of [geometry.main, geometry.footer]) {
      expect(Math.abs(surface.left - geometry.header.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(surface.right - geometry.header.right)).toBeLessThanOrEqual(1)
    }
    expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width)
    expect(geometry.socialTargets).toHaveLength(3)
    expect(geometry.socialTargets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true)

    if (viewport.stacked) {
      expect(geometry.brand.bottom).toBeLessThanOrEqual(geometry.navigation.top)
      expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.social.top)
    } else {
      expect(geometry.brand.right).toBeLessThanOrEqual(geometry.navigation.left)
      expect(geometry.navigation.right).toBeLessThanOrEqual(geometry.social.left)
    }
  }
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
