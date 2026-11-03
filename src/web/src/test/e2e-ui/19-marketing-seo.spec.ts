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

test("homepage keeps Tutorials in the footer and collapses mobile header links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))

  const header = page.locator("nav.marketing-nav")
  await expect.poll(() => header.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible")

  const inlineLinks = header.locator(".marketing-site-link")
  await expect(inlineLinks).toHaveCount(4)
  for (const link of await inlineLinks.all()) await expect(link).toBeHidden()

  const mobileMenu = header.locator("details")
  await mobileMenu.locator("summary").click()
  const mobileLinks = mobileMenu.locator(".marketing-mobile-site-link")
  await expect(mobileLinks).toHaveCount(4)
  const expectedLinks = [
    { href: "/download", label: "Download" },
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
  expect(await footerLinks.evaluateAll(linkContract)).toEqual([
    ...expectedLinks,
    { href: "/tutorials", label: "Tutorials" },
  ])

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
    await expect(page.getByRole("heading", { name: "Free", exact: true }).locator("..").getByRole("button")).not.toHaveText("Loading…")
    await expect(contact).toBeInViewport()
    await expect(async () => {
      const box = await contact.boundingBox()
      const plans = await page.getByRole("region", { name: "Alook plans" }).boundingBox()
      expect(box).not.toBeNull()
      expect(plans).not.toBeNull()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.y + box!.height).toBeLessThan(plans!.y)
    }).toPass({ timeout: 10_000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: testInfo.outputPath("pricing-contact.png") })
    await contact.focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/contact$/)
    await expect(page.getByRole("heading", { name: "Let’s talk." })).toBeVisible()
    await expect.poll(contactLayout).toEqual(direct)

    await page.route("**/api/pricing", (route) => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }),
    }))
    await page.goto("/pricing")
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Couldn't load plans")
    await expect(page.getByRole("heading", { name: "Free", exact: true }).locator("..").getByRole("button")).toBeDisabled()
    await expect(contact).toBeInViewport()
    await contact.focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/contact$/)
    await expect(page.getByRole("heading", { name: "Let’s talk." })).toBeVisible()
    await expect.poll(contactLayout).toEqual(direct)

    await page.getByRole("navigation", { name: "Site navigation" }).getByRole("link", { name: "Download", exact: true }).click()
    await expect(page).toHaveURL(/\/download$/)
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Good company.")
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://alook.ai/download")
    await expect(page.getByLabel("Store availability").getByText("Coming soon", { exact: true })).toHaveCount(2)
    const beta = page.locator("#mobile").getByRole("link", { name: "iPhone & iPad Public beta", exact: true })
    await expect(beta).toHaveAttribute("href", "https://testflight.apple.com/join/4fHgVBVF")
    const betaBox = await beta.boundingBox()
    const apkBox = await page.getByRole("heading", { name: "Android APK", exact: true }).boundingBox()
    expect(betaBox!.y + betaBox!.height).toBeLessThanOrEqual(apkBox!.y)

    await expect(page.getByRole("link", { name: "App Store", exact: true })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "Google Play", exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: testInfo.outputPath("download-shared-header.png"), fullPage: true })
    await page.getByRole("navigation", { name: "Site navigation" }).getByRole("link", { name: "Contact", exact: true }).focus()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/contact$/)
    await expect.poll(contactLayout).toEqual(direct)
  })
}


test("landing gallery preserves order, responsive geometry, and keyboard selection", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  for (const width of [1440, 1024, 820, 768, 640, 639, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    const order = await page.locator("#testimonials, #workspace, #product").evaluateAll(elements => elements.map(element => element.id))
    expect(order).toEqual(["testimonials", "workspace", "product"])
    await expect(page.getByRole("heading", { name: "Try it. Imagine your team and friends here." })).toHaveCount(1)
    const tabs = page.getByRole("tablist", { name: "Features" }).getByRole("tab")
    await tabs.first().scrollIntoViewIfNeeded()
    await expect(tabs).toHaveCount(5)
    for (const tab of await tabs.all()) {
      await tab.click()
      await expect(tab).toHaveAttribute("aria-selected", "true")
      await expect(page.getByRole("tabpanel")).toHaveCount(1)
      const bounds = await tab.boundingBox()
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      const stage = page.getByRole("tabpanel").locator(":scope > div").last()
      await stage.scrollIntoViewIfNeeded()
      const liveMedia = `[data-testid="${tid.landingMotionStage}"]:visible, [data-testid="${tid.landingMobileMotionStage}"]:visible`
      await expect.poll(async () => {
        if (!await stage.locator(liveMedia).count()) return false
        const slots = await stage.locator("[data-landing-deferred]:visible").all()
        const liveCounts = await Promise.all(slots.map(slot => slot.locator(liveMedia).count()))
        return liveCounts.every(count => count > 0)
      }, { message: `Live gallery media at ${width}px for ${await tab.textContent()}` }).toBe(true)
      if (width <= 639) {
        const media = stage.locator(":scope > figure, :scope > div[aria-label], :scope > div:has([role=img])").first()
        const mediaBounds = await media.boundingBox()
        const ctaBounds = await page.getByRole("tabpanel").getByRole("link").boundingBox()
        expect(mediaBounds!.y - ctaBounds!.y - ctaBounds!.height, JSON.stringify({ width, tab: await tab.textContent() })).toBeLessThanOrEqual(140)
      }
      if (width <= 1024) {
        await expect(stage.getByTestId(tid.landingMotionStage)).toHaveAttribute("data-layout", "compact")
        if (await stage.getByTestId(tid.landingIdentityCardTilt).count()) {
          await expect(stage.getByTestId(tid.landingIdentityCardTilt)).toHaveCSS("transform", "none")
        }
        const paragraphs = stage.locator('div[data-visible="true"] p:visible')
        if (await paragraphs.count()) {
          const text = await paragraphs.last().evaluate((element, motionStageId) => {
            const box = element.getBoundingClientRect()
            const frame = element.closest(`div[data-testid="${motionStageId}"]`)!.getBoundingClientRect()
            return { size: parseFloat(getComputedStyle(element).fontSize), left: box.left - frame.left, right: box.right - frame.right, bottom: box.bottom - frame.bottom, overflow: element.scrollWidth - element.clientWidth }
          }, tid.landingMotionStage)
          expect(text.size).toBeGreaterThanOrEqual(14)
          expect(text.left).toBeGreaterThanOrEqual(0)
          expect(text.right).toBeLessThanOrEqual(1)
          expect(text.overflow).toBeLessThanOrEqual(1)
          expect(text.bottom).toBeLessThanOrEqual(1)
        }
      }
      const geometry = await stage.evaluate(element => {
        const box = element.getBoundingClientRect()
        return { top: box.top + window.scrollY, height: box.height, children: [...element.children].map(child => {
          const rect = child.getBoundingClientRect()
          return { top: rect.top - box.top, bottom: rect.bottom - box.top }
        }) }
      })
      expect(geometry.children.every(child => child.top >= -1 && child.bottom <= geometry.height + 1), JSON.stringify({ width, tab: await tab.textContent(), geometry })).toBe(true)
    }
    await tabs.last().press("Home")
    await expect(tabs.first()).toBeFocused()
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true")
  }
})


test("landing gallery mobile playback keeps full-size readable messages", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/", { waitUntil: "networkidle" })
  const stage = page.getByRole("tabpanel").locator(":scope > div").last()
  await stage.scrollIntoViewIfNeeded()
  const motion = stage.getByTestId(tid.landingMotionStage)
  await motion.scrollIntoViewIfNeeded()
  await expect.poll(async () => Number(await motion.getAttribute("data-beat"))).toBeGreaterThanOrEqual(3)
  const paragraph = stage.locator('div[data-visible="true"] p:visible').first()
  const geometry = await paragraph.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    const animations: Animation[] = []
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      animations.push(...parent.getAnimations())
    }
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)))
    let scale = 1
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const transform = getComputedStyle(parent).transform
      if (transform !== "none") scale *= new DOMMatrix(transform).a
    }
    return { scale, size: parseFloat(getComputedStyle(element).fontSize), overflow: element.scrollWidth - element.clientWidth }
  })
  expect(geometry.scale).toBeGreaterThanOrEqual(0.99)
  expect(geometry.scale).toBeLessThanOrEqual(1.01)
  expect(geometry.size).toBeGreaterThanOrEqual(14)
  expect(geometry.overflow).toBeLessThanOrEqual(1)
})
