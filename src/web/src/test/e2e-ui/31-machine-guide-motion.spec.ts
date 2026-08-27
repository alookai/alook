import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

test("first-signup mobile guide clears the empty-state actions across the full flight", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()

  try {
    await page.goto("/sign-in")
    await page.getByRole("textbox", { name: "Email" }).fill(
      `guide-motion-${process.pid}-${Date.now()}@example.com`,
    )
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.waitForURL("**/c/me/machines", { waitUntil: "commit" })
    await expect(page.getByRole("heading", { name: "No machines yet" })).toBeVisible()

    await page.waitForFunction(
      ({ travellerId, scaleAnimationName }) => {
        const traveller = document.querySelector(`[data-testid="${travellerId}"]`)
        const scale = traveller?.querySelector(".community-first-signup-guide-scale")
        return Boolean(
          traveller?.getAnimations().some(
            (animation) => animation instanceof CSSAnimation &&
              animation.animationName === "community-first-signup-guide-travel",
          ) && scale?.getAnimations().some(
            (animation) => animation instanceof CSSAnimation &&
              animation.animationName === scaleAnimationName,
          ),
        )
      },
      {
        travellerId: tid.machineFirstSignupGuide,
        scaleAnimationName: "community-first-signup-guide-scale-mobile",
      },
    )

    const report = await page.evaluate(({ travellerId, targetId }) => {
      const traveller = document.querySelector(`[data-testid="${travellerId}"]`)
      const scale = traveller?.querySelector(".community-first-signup-guide-scale")
      const target = document.querySelector(`[data-testid="${targetId}"]`)
      const connect = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Connect a machine",
      )
      const guide = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Guide me",
      )
      const copy = [...document.querySelectorAll("p")].find((element) =>
        element.textContent?.includes("your bots run on it always-on"),
      )
      if (
        !(traveller instanceof HTMLElement) ||
        !(scale instanceof HTMLElement) ||
        !(target instanceof HTMLElement) ||
        !(connect instanceof HTMLElement) ||
        !(guide instanceof HTMLElement) ||
        !(copy instanceof HTMLElement)
      ) {
        throw new Error("mobile guide geometry targets are missing")
      }

      const travelAnimation = traveller.getAnimations().find(
        (animation) => animation instanceof CSSAnimation &&
          animation.animationName === "community-first-signup-guide-travel",
      )
      const scaleAnimation = scale.getAnimations().find(
        (animation) => animation instanceof CSSAnimation &&
          animation.animationName === "community-first-signup-guide-scale-mobile",
      )
      if (!travelAnimation || !scaleAnimation) {
        throw new Error("mobile guide animations are missing")
      }
      travelAnimation.pause()
      scaleAnimation.pause()

      const rect = (element: Element) => {
        const value = element.getBoundingClientRect()
        return {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        }
      }
      const overlapArea = (
        a: ReturnType<typeof rect>,
        b: ReturnType<typeof rect>,
      ) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
        Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))

      const connectRect = rect(connect)
      const guideRect = rect(guide)
      const copyRect = rect(copy)
      const targetRect = rect(target)
      const violations = {
        connect: [] as number[],
        largeClearance: [] as number[],
        viewport: [] as number[],
        scaleIncrease: [] as number[],
      }
      let previousSize = Number.POSITIVE_INFINITY
      let minLargeClearance = Number.POSITIVE_INFINITY
      let maxBottom = Number.NEGATIVE_INFINITY
      let finalRect = rect(scale)

      // The flight occupies 67.5%–97.5% of the 4s animation. Sampling 401
      // points covers both endpoints and every 0.25% increment of the flight.
      for (let index = 0; index <= 400; index += 1) {
        const progress = index / 400
        const currentTime = 2700 + progress * 1200
        travelAnimation.currentTime = currentTime
        scaleAnimation.currentTime = currentTime

        const avatarRect = rect(scale)
        const connectOverlap = overlapArea(avatarRect, connectRect)
        const guideOverlap = overlapArea(avatarRect, guideRect)
        const clearance = avatarRect.top - Math.max(connectRect.bottom, guideRect.bottom, copyRect.bottom)

        if (connectOverlap > 0.01) violations.connect.push(index)
        if (avatarRect.width > 32) {
          minLargeClearance = Math.min(minLargeClearance, clearance)
          if (clearance < 8 || guideOverlap > 0.01) {
            violations.largeClearance.push(index)
          }
        }
        if (
          avatarRect.left < -0.01 ||
          avatarRect.top < -0.01 ||
          avatarRect.right > innerWidth + 0.01 ||
          avatarRect.bottom > innerHeight + 0.01
        ) {
          violations.viewport.push(index)
        }
        if (avatarRect.width > previousSize + 0.01) {
          violations.scaleIncrease.push(index)
        }

        previousSize = avatarRect.width
        maxBottom = Math.max(maxBottom, avatarRect.bottom)
        finalRect = avatarRect
      }

      return {
        sampleCount: 401,
        violations,
        minLargeClearance,
        maxBottom,
        finalRect,
        targetRect,
      }
    }, {
      travellerId: tid.machineFirstSignupGuide,
      targetId: tid.machineGuideAvatarTarget,
    })

    expect(report.sampleCount).toBe(401)
    expect(report.violations).toEqual({
      connect: [],
      largeClearance: [],
      viewport: [],
      scaleIncrease: [],
    })
    expect(report.minLargeClearance).toBeGreaterThanOrEqual(8)
    expect(report.maxBottom).toBeLessThanOrEqual(844)
    for (const key of ["left", "top", "right", "bottom", "width", "height"] as const) {
      expect(report.finalRect[key]).toBeCloseTo(report.targetRect[key], 4)
    }
  } finally {
    await context.close()
  }
})
