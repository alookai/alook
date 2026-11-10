import { expect, test } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

function motionCanvasGeometry(element: Element) {
  const canvas = element.firstElementChild
  if (!(canvas instanceof HTMLElement)) return null
  const stage = element.getBoundingClientRect()
  const painted = canvas.getBoundingClientRect()
  const transform = new DOMMatrix(getComputedStyle(canvas).transform)
  return {
    width: stage.width, height: stage.height, layoutWidth: (element as HTMLElement).clientWidth,
    canvasWidth: canvas.offsetWidth, canvasHeight: canvas.offsetHeight,
    scaleX: transform.a, scaleY: transform.d, skewX: transform.c, skewY: transform.b,
    paintedWidth: painted.width, paintedHeight: painted.height,
    left: painted.left - stage.left, top: painted.top - stage.top,
  }
}

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
    { width: 320, height: 844, stacked: true },
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
    const social = page.getByTestId(tid.landingFooterSocial)
    const socialAnchors = social.locator("a")
    await expect(socialAnchors).toHaveCount(3)
    const expectedSocial = [
      { name: "GitHub", href: "https://github.com/alookai/alook" },
      { name: "Discord", href: "https://discord.com/invite/24PHyEHU3M" },
      { name: "Follow us on X", href: "https://x.com/alook_ai" },
    ]
    const actualSocial = []
    for (const expected of expectedSocial) {
      const link = social.getByRole("link", { name: expected.name, exact: true })
      await expect(link).toHaveCount(1)
      actualSocial.push({ name: expected.name, href: await link.getAttribute("href") })
    }
    expect(actualSocial).toEqual(expectedSocial)
    const socialTargets = await socialAnchors
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
      sloganContent: await page.getByTestId(tid.landingFooterSlogan).evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
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
      expect(geometry.sloganWhiteSpace).toBe("normal")
      expect(geometry.sloganContent.scrollWidth).toBeLessThanOrEqual(geometry.sloganContent.clientWidth)
      expect(geometry.sloganContent.scrollHeight).toBeLessThanOrEqual(geometry.sloganContent.clientHeight)
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

  const header = page.getByRole("navigation", { includeHidden: true }).filter({ has: page.getByTestId(tid.landingHeaderContainer) })
  await expect.poll(() => header.evaluate((element) => getComputedStyle(element).visibility)).toBe("visible")

  const siteAnchors = 'a:not([href="/"]):not([href="/sign-in"]):not([href="/c/me"]):not([href="https://github.com/alookai/alook"]):not([href="https://discord.com/invite/24PHyEHU3M"]):not([href="https://x.com/alook_ai"])'
  const inlineLinks = header.locator(`${siteAnchors}:not(details a)`)
  await expect(header.getByRole("link", { name: "Tutorials", exact: true, includeHidden: true })).toHaveCount(0)
  await expect(inlineLinks).toHaveCount(4)
  for (const link of await inlineLinks.all()) await expect(link).toBeHidden()

  const mobileMenu = header.locator("details")
  await mobileMenu.locator("summary").click()
  const mobileLinks = mobileMenu.locator(siteAnchors)
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
  // Header and footer links share one family, spacing, case and motion. The
  // footer is the quieter tier: muted ink and its own type size.
  const sharedContract = async (link: typeof footerLinks) => {
    const { color: _color, fontSize: _fontSize, ...shared } = await link.evaluate(styleContract)
    return shared
  }
  // Resolves a landing token where the link lives and compares it with the link's ink.
  const inkMatchesToken = (link: typeof footerLinks, token: string) => link.evaluate((element, name) => {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    element.parentElement!.appendChild(probe)
    try {
      return { actual: getComputedStyle(element).color, expected: getComputedStyle(probe).color }
    } finally {
      probe.remove()
    }
  }, token)
  const expectLinkTiers = async (headerLink: typeof footerLinks) => {
    expect(await sharedContract(headerLink)).toEqual(await sharedContract(footerLinks.first()))
    const header = await inkMatchesToken(headerLink, "--landing-text")
    expect(header.actual).toBe(header.expected)
    const footer = await inkMatchesToken(footerLinks.first(), "--landing-text-muted")
    expect(footer.actual).toBe(footer.expected)
    expect(footer.actual).not.toBe(header.actual)
  }
  await expectLinkTiers(mobileLinks.first())
  await mobileMenu.locator("summary").click()
  await expect(mobileMenu).toHaveJSProperty("open", false)

  await page.setViewportSize({ width: 768, height: 900 })
  for (const link of await inlineLinks.all()) await expect(link).toBeVisible()
  await expectLinkTiers(inlineLinks.first())
})

test("desktop landing keeps the embedded phone Back control on true mobile geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")

  await page.getByRole("tab", { name: "Remote control" }).click()
  await page.getByRole("tabpanel").locator(":scope > div").last().scrollIntoViewIfNeeded()
  await page.locator('[data-slot="phone-mockup-card"]').scrollIntoViewIfNeeded()
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
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
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

    // Subpages share the home bar (QA #14); its logo is the way home.
    await page.getByRole("navigation", { name: "Site navigation" }).getByRole("link", { name: "Alook home", exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.getByRole("heading", { level: 1 }).locator("xpath=ancestor::section").evaluate((hero) => window.scrollTo(0, hero.getBoundingClientRect().bottom + window.scrollY + 1))
    const nav = page.getByRole("navigation", { includeHidden: true }).filter({ has: page.getByTestId(tid.landingHeaderContainer) })
    await expect(nav).toBeVisible()
    if (width < 640) await nav.locator("summary").click()
    await nav.getByRole("link", { name: "Contact", exact: true }).filter({ visible: true }).click()
    await expect(page).toHaveURL(/\/contact$/)
    await expect.poll(contactLayout).toEqual(direct)

    // Subpages share the home bar (QA #14); its logo is the way home.
    await page.getByRole("navigation", { name: "Site navigation" }).getByRole("link", { name: "Alook home", exact: true }).click()
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
    let releaseSession!: () => void
    const sessionHeld = new Promise<void>(resolve => { releaseSession = resolve })
    let sessionCaptured = false, sessionWasNull = false
    let sessionStatus = 0
    await page.route("**/api/auth/get-session", async route => {
      const response = await route.fetch()
      sessionStatus = response.status()
      sessionWasNull = await response.json() === null
      sessionCaptured = true
      await sessionHeld
      await route.fulfill({ response })
    })
    try {
      await page.goto("/pricing")
      await expect(page.getByRole("main").getByRole("alert")).toContainText("Couldn't load plans")
      const freeButton = page.getByRole("heading", { name: "Free", exact: true }).locator("..").getByRole("button")
      await expect(freeButton).toBeDisabled()
      await expect(freeButton).toHaveText("Loading…")
      await expect(contact).toBeInViewport()
      await expect.poll(() => sessionCaptured).toBe(true)
      expect(sessionStatus).toBe(200)
      expect(sessionWasNull).toBe(true)
      const originalContact = await contact.elementHandle()
      if (!originalContact) throw new Error("Missing public Contact link")
      await contact.focus()
      expect(await originalContact.evaluate(node => node === document.activeElement)).toBe(true)
      releaseSession()
      await expect(freeButton).not.toHaveText("Loading…")
      expect(await originalContact.evaluate(node => node.isConnected)).toBe(true)
      expect(await contact.evaluate((node, original) => node === original, originalContact)).toBe(true)
      expect(await originalContact.evaluate(node => node === document.activeElement)).toBe(true)
      await page.keyboard.press("Enter")
      await expect(page).toHaveURL(/\/contact$/)
      await expect(page.getByRole("heading", { name: "Let’s talk." })).toBeVisible()
      await expect.poll(contactLayout).toEqual(direct)
    } finally {
      releaseSession()
      await page.unrouteAll({ behavior: "wait" })
    }

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
    await expect(page.getByRole("heading", { name: "Try it: imagine your team and friends here" })).toHaveCount(1)
    const tabs = page.getByRole("tablist", { name: "Features" }).getByRole("tab")
    await tabs.first().scrollIntoViewIfNeeded()
    await expect(tabs).toHaveCount(5)
    for (const tab of await tabs.all()) {
      await tabs.first().evaluate(element => element.parentElement!.scrollIntoView({ block: "center" }))
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
      await expect(stage.locator(`:scope > figure, :scope > div[aria-label], :scope > div:has([role=img]), :scope > div:has([data-testid='${tid.profileCard}'])`).first()).toBeVisible()
      const motion = stage.getByTestId(tid.landingMotionStage).first()
      if (await tab.textContent() === "Agent identity") {
        await expect(stage.getByTestId(tid.profileCard)).toBeVisible()
        await expect(motion).toHaveCount(0)
      } else {
        await expect(async () => {
          const geometry = await motion.evaluate(motionCanvasGeometry)
          expect(geometry).not.toBeNull()
          expect(geometry!.width).toBeGreaterThan(0)
          expect(geometry!.height).toBeGreaterThan(0)
          expect(geometry!.canvasWidth).toBe(1120)
          expect(geometry!.canvasHeight).toBeGreaterThan(0)
          expect(geometry!.scaleX).toBeCloseTo(geometry!.layoutWidth / 1120, 3)
          expect(geometry!.scaleY).toBeCloseTo(geometry!.scaleX, 3)
          expect(geometry!.skewX).toBe(0)
          expect(geometry!.skewY).toBe(0)
          expect(geometry!.paintedWidth).toBeCloseTo(geometry!.width, 0)
          expect(geometry!.paintedHeight).toBeCloseTo(geometry!.height, 0)
          expect(geometry!.left).toBeCloseTo(0, 0)
          expect(geometry!.top).toBeCloseTo(0, 0)
        }).toPass({ timeout: 10_000 })
        // every deferred media slot of a motion tab must hold live media (main #1168)
        const liveMedia = `[data-testid="${tid.landingMotionStage}"]:visible, [data-testid="${tid.landingMobileMotionStage}"]:visible`
        await expect.poll(async () => {
          if (!await stage.locator(liveMedia).count()) return false
          const slots = await stage.locator("[data-landing-deferred]:visible").all()
          // a slot is live once its motion stage is mounted; the phone stage may sit hidden between beats
          const mounted = `[data-testid="${tid.landingMotionStage}"], [data-testid="${tid.landingMobileMotionStage}"]`
          const liveCounts = await Promise.all(slots.map(slot => slot.locator(mounted).count()))
          return liveCounts.every(count => count > 0)
        }, { message: `Live gallery media at ${width}px for ${await tab.textContent()}` }).toBe(true)
      }
      if (await tab.textContent() === "Remote control") {
        const screenRatio = await motion.evaluate(element => {
          const canvas = element.firstElementChild!
          return canvas.getBoundingClientRect().width / element.getBoundingClientRect().width
        })
        expect(screenRatio).toBeCloseTo(1, 2)
        const phone = stage.getByTestId(tid.landingMobileMotionStage)
        const phoneRatio = await phone.evaluate(element => element.firstElementChild!.getBoundingClientRect().width / element.getBoundingClientRect().width)
        expect(phoneRatio).toBeCloseTo(1, 2)
      }
      if (width === 390) {
        await page.locator("#product").evaluate(element => element.scrollIntoView({ block: "start" }))
        for (const element of [page.getByRole("tablist", { name: "Features" }), page.getByRole("tabpanel").getByRole("heading"), page.getByRole("tabpanel").getByRole("link"), stage]) {
          const rect = await element.boundingBox()
          expect(rect!.y).toBeGreaterThanOrEqual(0)
          expect(rect!.y + rect!.height).toBeLessThanOrEqual(844)
        }
      }
      const tabTops = await tabs.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top))
      expect(Math.max(...tabTops) - Math.min(...tabTops)).toBeLessThanOrEqual(1)
      await expect(page.getByRole("button", { name: /feature rotation/ })).toHaveCount(0)
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


test("landing gallery mobile playback scales the complete original scene", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/", { waitUntil: "networkidle" })
  const stage = page.getByRole("tabpanel").locator(":scope > div").last()
  await stage.scrollIntoViewIfNeeded()
  const motion = stage.getByTestId(tid.landingMotionStage)
  await motion.scrollIntoViewIfNeeded()
  await expect.poll(async () => Number(await motion.getAttribute("data-beat"))).toBeGreaterThanOrEqual(3)
  const geometry = await motion.evaluate(motionCanvasGeometry)
  expect(geometry).not.toBeNull()
  expect(geometry!.width).toBeGreaterThan(0)
  expect(geometry!.height).toBeGreaterThan(0)
  expect(geometry!.canvasWidth).toBe(1120)
  expect(geometry!.canvasHeight).toBeGreaterThan(0)
  expect(geometry!.scaleX).toBeCloseTo(geometry!.layoutWidth / 1120, 3)
  expect(geometry!.scaleY).toBeCloseTo(geometry!.scaleX, 3)
  expect(geometry!.skewX).toBe(0)
  expect(geometry!.skewY).toBe(0)
  expect(geometry!.paintedWidth).toBeCloseTo(geometry!.width, 0)
  expect(geometry!.paintedHeight).toBeCloseTo(geometry!.height, 0)
  expect(geometry!.left).toBeCloseTo(0, 0)
  expect(geometry!.top).toBeCloseTo(0, 0)
  await expect.poll(async () => Number(await motion.getAttribute("data-beat"))).toBeGreaterThanOrEqual(6)
})


test("landing gallery reveals offscreen tabs with mouse drag and wheel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  const tabs = page.getByRole("tablist", { name: "Features" })
  await tabs.scrollIntoViewIfNeeded()
  const box = (await tabs.boundingBox())!
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  expect(await tabs.evaluate(element => element.scrollLeft)).toBeGreaterThan(100)
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Collaboration")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 800)
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth - 1)).toBe(true)
  await tabs.getByRole("tab", { name: "Persistent Memory", exact: true }).click()
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Persistent Memory")
  await page.mouse.wheel(0, -800)
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBe(0)
  await tabs.getByRole("tab", { name: "Collaboration", exact: true }).click()
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Collaboration")
})


test("landing gallery slides between features and settles the latest selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  const tabs = page.getByRole("tablist", { name: "Features" })
  await tabs.scrollIntoViewIfNeeded()
  const slide = page.getByTestId(tid.landingFeatureTransition)
  const observation = await slide.evaluateHandle(element => {
    const original = Element.prototype.animate
    const incoming: Animation[] = []
    const observer = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = original.apply(this, args)
      if (this === element.firstElementChild) {
        animation.pause()
        incoming.push(animation)
      }
      return animation
    }
    Element.prototype.animate = observer
    const release = () => {
      for (const animation of incoming) {
        if (animation.playState !== "idle" && animation.playState !== "finished") animation.play()
      }
    }
    return {
      async startGeometry() {
        const animation = incoming.at(-1)
        if (!animation) throw new Error("No incoming slide animation was observed")
        await animation.ready
        if (animation.playState !== "paused") throw new Error("Incoming slide is not paused")
        const content = element.firstElementChild
        if (!(content instanceof HTMLElement) || (animation.effect as KeyframeEffect).target !== content) {
          throw new Error("Incoming slide does not own the current content")
        }
        animation.currentTime = 0
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const frame = element.getBoundingClientRect()
        const current = content.getBoundingClientRect()
        const border = parseFloat(getComputedStyle(element).borderLeftWidth) || 0
        return { width: current.width, height: current.height, displacement: current.left - frame.left - border - content.offsetLeft }
      },
      release,
      restore() {
        if (Element.prototype.animate === observer) Element.prototype.animate = original
        release()
      },
    }
  })
  try {
    await tabs.getByRole("tab", { name: "Remote control", exact: true }).click()
    const forward = await observation.evaluate(observer => observer.startGeometry())
    expect(forward.width).toBeGreaterThan(0)
    expect(forward.height).toBeGreaterThan(0)
    expect(forward.displacement).toBeCloseTo(forward.width, 0)
    await observation.evaluate(observer => observer.release())
    await expect.poll(() => slide.evaluate(element => ({ count: element.children.length, inert: (element.firstElementChild as HTMLElement).inert })))
      .toEqual({ count: 1, inert: false })
    await tabs.getByRole("tab", { name: "Collaboration", exact: true }).click()
    const backward = await observation.evaluate(observer => observer.startGeometry())
    expect(backward.width).toBeGreaterThan(0)
    expect(backward.height).toBeGreaterThan(0)
    expect(backward.displacement).toBeCloseTo(-backward.width, 0)
    await tabs.getByRole("tab", { name: "Agent identity", exact: true }).click()
    await tabs.getByRole("tab", { name: "Persistent Memory", exact: true }).click()
    await observation.evaluate(observer => observer.release())
    await expect.poll(() => slide.evaluate(element => ({ count: element.children.length, inert: (element.firstElementChild as HTMLElement).inert })))
      .toEqual({ count: 1, inert: false })
    await expect(page.getByRole("tabpanel")).toHaveCount(1)
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText("Persistent Memory")
    expect(await slide.evaluate(element => ({ count: element.children.length, inert: (element.firstElementChild as HTMLElement).inert }))).toEqual({ count: 1, inert: false })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  } finally {
    try { await observation.evaluate(observer => observer.restore()) }
    finally { await observation.dispose() }
  }
})
