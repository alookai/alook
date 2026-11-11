import type { Locator } from "@playwright/test"
import { expect } from "./case-fixture"

export async function expectScrollFade(rail: Locator, state: "start" | "middle" | "end" | "none", axis: "x" | "y" = "x") {
  const animated = await rail.evaluate(() => CSS.supports("animation-timeline: scroll()"))
  const start = animated ? state === "middle" || state === "end" : true
  const end = animated ? state === "middle" || state === "start" : true
  await expect.poll(() => rail.evaluate((element, direction) => {
    const style = getComputedStyle(element)
    return {
      masked: style.maskImage.includes("linear-gradient"),
      start: Number.parseFloat(style.getPropertyValue(direction === "x" ? "--scroll-fade-s" : "--scroll-fade-t")) > 0,
      end: Number.parseFloat(style.getPropertyValue(direction === "x" ? "--scroll-fade-e" : "--scroll-fade-b")) > 0,
    }
  }, axis)).toEqual({ masked: true, start, end })
}
