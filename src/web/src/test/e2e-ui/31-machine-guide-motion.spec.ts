import { test, expect } from "./_fixtures/community-fixture"
import { tid } from "./_fixtures/testids"

for (const viewport of [
  { name: "mobile", width: 390, height: 844, sourceTag: "SPAN" },
  { name: "desktop", width: 1280, height: 800, sourceTag: "BUTTON" },
]) {
  test(`first-signup ${viewport.name} guide travels from beside Machines into the orbit`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    })
    const page = await context.newPage()

    try {
      await page.goto("/sign-in")
      await page.getByRole("textbox", { name: "Email" }).fill(
        `guide-motion-${viewport.name}-${process.pid}-${Date.now()}@example.com`,
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
          scaleAnimationName: viewport.name === "mobile"
            ? "community-first-signup-guide-scale-mobile"
            : "community-first-signup-guide-scale",
        },
      )

      const report = await page.evaluate(({
        travellerId,
        targetId,
        sourceId,
        scaleAnimationName,
      }) => {
        const traveller = document.querySelector(`[data-testid="${travellerId}"]`)
        const scale = traveller?.querySelector(".community-first-signup-guide-scale")
        const target = document.querySelector(`[data-testid="${targetId}"]`)
        const source = [...document.querySelectorAll(`[data-testid="${sourceId}"]`)]
          .find((element) => {
            const value = element.getBoundingClientRect()
            return value.width > 0 && value.height > 0 &&
              value.right > 0 && value.bottom > 0 &&
              value.left < innerWidth && value.top < innerHeight
          })
        if (
          !(traveller instanceof HTMLElement) ||
          !(scale instanceof HTMLElement) ||
          !(target instanceof HTMLElement) ||
          !(source instanceof HTMLElement)
        ) {
          throw new Error("guide motion geometry targets are missing")
        }

        const travelAnimation = traveller.getAnimations().find(
          (animation) => animation instanceof CSSAnimation &&
            animation.animationName === "community-first-signup-guide-travel",
        )
        const scaleAnimation = scale.getAnimations().find(
          (animation) => animation instanceof CSSAnimation &&
            animation.animationName === scaleAnimationName,
        )
        if (!travelAnimation || !scaleAnimation) {
          throw new Error("guide motion animations are missing")
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

        // 7.5% is the first fully visible frame, after the short fade-in.
        travelAnimation.currentTime = 300
        scaleAnimation.currentTime = 300
        const sourceRect = rect(source)
        const startRect = rect(scale)

        const violations = {
          viewport: [] as number[],
          scaleIncrease: [] as number[],
        }
        let previousSize = Number.POSITIVE_INFINITY
        let finalRect = startRect

        // The flight occupies 67.5%–97.5% of the 4s animation. Sampling 401
        // points covers both endpoints and every 0.25% increment of the flight.
        for (let index = 0; index <= 400; index += 1) {
          const progress = index / 400
          const currentTime = 2700 + progress * 1200
          travelAnimation.currentTime = currentTime
          scaleAnimation.currentTime = currentTime

          const avatarRect = rect(scale)
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
          finalRect = avatarRect
        }

        return {
          sourceTag: source.tagName,
          startGap: startRect.left - sourceRect.right,
          startTopDelta: startRect.top - sourceRect.top,
          violations,
          finalRect,
          targetRect: rect(target),
        }
      }, {
        travellerId: tid.machineFirstSignupGuide,
        targetId: tid.machineGuideAvatarTarget,
        sourceId: tid.machineGuideIntroSource,
        scaleAnimationName: viewport.name === "mobile"
          ? "community-first-signup-guide-scale-mobile"
          : "community-first-signup-guide-scale",
      })

      expect(report.sourceTag).toBe(viewport.sourceTag)
      expect(report.startGap).toBeCloseTo(16, 1)
      expect(Math.abs(report.startTopDelta)).toBeLessThanOrEqual(8)
      expect(report.violations).toEqual({ viewport: [], scaleIncrease: [] })
      for (const key of ["left", "top", "right", "bottom", "width", "height"] as const) {
        expect(report.finalRect[key]).toBeCloseTo(report.targetRect[key], 4)
      }
    } finally {
      await context.close()
    }
  })
}
