import type { Locator } from "@playwright/test"
import { expect } from "./case-fixture"

export async function expectScrollFade(rail: Locator, state: "start" | "middle" | "end" | "none") {
  const animated = await rail.evaluate(() => CSS.supports("animation-timeline: scroll()"))
  const start = animated ? state === "middle" || state === "end" : true
  const end = animated ? state === "middle" || state === "start" : true
  await expect.poll(() => rail.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      masked: style.maskImage.includes("linear-gradient"),
      start: Number.parseFloat(style.getPropertyValue("--scroll-fade-s")) > 0,
      end: Number.parseFloat(style.getPropertyValue("--scroll-fade-e")) > 0,
    }
  })).toEqual({ masked: true, start, end })
}
