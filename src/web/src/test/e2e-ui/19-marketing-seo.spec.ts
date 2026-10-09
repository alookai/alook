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
    { width: 1920, height: 900, stacked: false },
    { width: 1440, height: 900, stacked: false },
    { width: 1100, height: 900, stacked: false },
    { width: 1099, height: 900, stacked: false },
    { width: 1024, height: 900, stacked: false },
    { width: 883, height: 900, stacked: false },
    { width: 640, height: 900, stacked: false },
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
      slogan: await rect(tid.landingFooterSlogan),
      navigation: await rect(tid.landingFooterNavigation),
      social: await rect(tid.landingFooterSocial),
      socialTargets,
      documentWidth: await page.evaluate(() => document.documentElement.scrollWidth),
      sloganWhiteSpace: await page
        .getByTestId(tid.landingFooterSlogan)
        .evaluate((element) => getComputedStyle(element).whiteSpace),
    }

    for (const surface of [geometry.main, geometry.footer]) {
      expect(Math.abs(surface.left - geometry.header.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(surface.right - geometry.header.right)).toBeLessThanOrEqual(1)
    }
    expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width)
    expect(geometry.socialTargets).toHaveLength(3)
    expect(geometry.socialTargets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true)

    const footerCenter = (geometry.footer.left + geometry.footer.right) / 2
    const navigationCenter = (geometry.navigation.left + geometry.navigation.right) / 2
    expect(Math.abs(navigationCenter - footerCenter)).toBeLessThanOrEqual(1)
    const sloganCenter = (geometry.slogan.left + geometry.slogan.right) / 2
    expect(Math.abs(sloganCenter - footerCenter)).toBeLessThanOrEqual(1)

    if (viewport.stacked) {
      expect(geometry.brand.bottom).toBeLessThanOrEqual(geometry.slogan.top)
      expect(geometry.slogan.bottom).toBeLessThanOrEqual(geometry.social.top)
      expect(geometry.social.bottom).toBeLessThanOrEqual(geometry.navigation.top)
      expect(geometry.sloganWhiteSpace).toBe("nowrap")
      for (const group of [geometry.brand, geometry.slogan, geometry.social]) {
        expect(Math.abs((group.left + group.right) / 2 - footerCenter)).toBeLessThanOrEqual(1)
      }
    } else {
      expect(geometry.brand.right).toBeLessThanOrEqual(geometry.slogan.left)
      expect(geometry.slogan.right).toBeLessThanOrEqual(geometry.social.left)
      expect(Math.max(geometry.brand.bottom, geometry.slogan.bottom, geometry.social.bottom))
        .toBeLessThanOrEqual(geometry.navigation.top)
    }
  }
})

test("homepage shares header and footer site links and collapses mobile header links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))

  const header = page.locator("nav.marketing-nav")
  await expect.poll(() => header.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible")

  const inlineLinks = header.locator(".marketing-site-link")
  await expect(inlineLinks).toHaveCount(3)
  for (const link of await inlineLinks.all()) await expect(link).toBeHidden()

  const mobileMenu = header.locator("details")
  await mobileMenu.locator("summary").click()
  const mobileLinks = mobileMenu.locator(".marketing-mobile-site-link")
  await expect(mobileLinks).toHaveCount(3)
  const expectedLinks = [
    { href: "/pricing", label: "Pricing" },
    { href: "/blog", label: "Blog" },
    { href: "/contact", label: "Contact" },
  ]
  const linkContract = (elements: Element[]) => elements.map((element) => ({
    href: element.getAttribute("href"),
    label: element.textContent?.trim(),
  }))
  expect(await mobileLinks.evaluateAll(linkContract)).toEqual(expectedLinks)
  const footerLinks = page.getByTestId(tid.landingFooterNavigation).locator("a")
  expect(await footerLinks.evaluateAll(linkContract)).toEqual(expectedLinks)

  const styleContract = (element: Element) => {
    const style = getComputedStyle(element)
    return {
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      letterSpacing: style.letterSpacing,
      paddingInlineEnd: style.paddingInlineEnd,
      paddingInlineStart: style.paddingInlineStart,
      textTransform: style.textTransform,
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
    }
  }
  expect(await mobileLinks.first().evaluate(styleContract))
    .toEqual(await footerLinks.first().evaluate(styleContract))

  await page.setViewportSize({ width: 768, height: 900 })
  for (const link of await inlineLinks.all()) await expect(link).toBeVisible()
  expect(await inlineLinks.first().evaluate(styleContract))
    .toEqual(await footerLinks.first().evaluate(styleContract))
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

for (const width of [1440, 390]) {
  test(`contact preserves its layout after client navigation at ${width}px`, async ({ page, context, baseURL }, testInfo) => {
    await context.addCookies([{ name: "alook_analytics_consent", value: "v1.denied", url: baseURL! }])
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/contact")
    await page.evaluate(() => document.fonts.ready)

    const gusX = page.getByRole("link", { name: "X @im_gusye", exact: true })
    await expect(gusX).toBeVisible()
    await expect(gusX).toHaveAttribute("href", "https://x.com/im_gusye")
    await gusX.focus()
    await expect(gusX).toBeFocused()
    expect((await gusX.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: testInfo.outputPath("contact-gus-x.png"), fullPage: true })

    const contactLayout = () => page.locator("main").evaluate((main) => {
      const sheet = main.querySelector("section")!
      const style = (element: Element, properties: string[]) => {
        const computed = getComputedStyle(element)
        return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]))
      }
      return {
        background: getComputedStyle(main.parentElement!).backgroundColor,
        sheet: style(sheet, ["padding", "min-height", "max-width"]),
        paper: getComputedStyle(sheet, "::before").backgroundColor,
        headings: Array.from(main.querySelectorAll("h1, h2")).map((heading) =>
          style(heading, ["font-size", "line-height", "margin-top"])),
        links: Array.from(main.querySelectorAll("a")).map((link) => {
          const box = link.getBoundingClientRect()
          return [box.x, box.y + window.scrollY, box.width, box.height].map((value) => Math.round(value))
        }),
      }
    })
    const direct = await contactLayout()

    await page.getByRole("link", { name: "Back to home", exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.locator(".hero-section").evaluate((hero) => window.scrollTo(0, hero.getBoundingClientRect().bottom + window.scrollY))
    const nav = page.locator("nav.marketing-nav")
    await expect(nav).toBeVisible()
    if (width < 640) await nav.locator("summary").click()
    await nav.getByRole("link", { name: "Contact", exact: true }).filter({ visible: true }).click()
    await expect(page).toHaveURL(/\/contact$/)
    await expect.poll(contactLayout).toEqual(direct)

    await page.getByRole("link", { name: "Back to home", exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.getByTestId(tid.landingFooterNavigation).getByRole("link", { name: "Contact", exact: true }).click()
    await expect(page).toHaveURL(/\/contact$/)
    await expect.poll(contactLayout).toEqual(direct)
    await page.goto("/pricing")
    const contact = page.getByRole("link", { name: "Contact us", exact: true })
    await expect(contact).toBeInViewport()
    const box = await contact.boundingBox()
    const plans = await page.getByRole("region", { name: "Alook plans" }).boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(box!.y + box!.height).toBeLessThan(plans!.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByTestId("pricing-choose-free")).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath("pricing-contact.png") })
    await contact.focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/contact$/)
    await expect(page.getByRole("heading", { name: "Let’s talk." })).toBeVisible()
    await expect.poll(contactLayout).toEqual(direct)
  })
}
