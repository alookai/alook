import { expect, test } from "@playwright/test"
import type { Locator, Page } from "@playwright/test"

const EXPECTED_OUTLINE = [
  { level: 1, text: "People and agents in the same room" },
  { level: 2, text: "Rooms where people talk" },
  { level: 2, text: "One identity" },
  { level: 2, text: "Agents keep things moving" },
  { level: 2, text: "Wherever you open it" },
  { level: 2, text: "Your machine runs the agent" },
  { level: 2, text: "Start your room with agents and people" },
]

function headingOutline(html: string) {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    text: match[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  }))
}

async function typography(locator: Locator) {
  return locator.evaluate((element) => {
    const styles = getComputedStyle(element)
    return {
      fontFamily: styles.fontFamily,
      letterSpacingRatio: Number.parseFloat(styles.letterSpacing) / Number.parseFloat(styles.fontSize),
      lineHeightRatio: Number.parseFloat(styles.lineHeight) / Number.parseFloat(styles.fontSize),
    }
  })
}

async function nativeHeadingTypography(page: Page, level: 1 | 2 | 3) {
  return page.evaluate((headingLevel) => {
    const heading = document.createElement(`h${headingLevel}`)
    heading.textContent = "Heading baseline"
    document.documentElement.appendChild(heading)
    const styles = getComputedStyle(heading)
    const result = {
      fontFamily: styles.fontFamily,
      letterSpacingRatio: Number.parseFloat(styles.letterSpacing) / Number.parseFloat(styles.fontSize),
      lineHeightRatio: Number.parseFloat(styles.lineHeight) / Number.parseFloat(styles.fontSize),
    }
    heading.remove()
    return result
  }, level)
}

test("homepage SSR exposes only the marketing heading outline", async ({ request }) => {
  const response = await request.get("/")

  expect(response.ok()).toBe(true)
  expect(headingOutline(await response.text())).toEqual(EXPECTED_OUTLINE)
})

test("presentational demo labels retain heading typography", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto("/")

  const timeline = page.getByTestId("landing-identity-timeline")
  const machineScene = page.getByTestId("landing-scene-machine")
  await timeline.scrollIntoViewIfNeeded()
  await expect(timeline).toBeVisible()
  await machineScene.scrollIntoViewIfNeeded()
  await expect(machineScene).toBeVisible()
  const labels = [
    { locator: timeline.locator("div.font-heading", { hasText: "Alli" }).first(), headingLevel: 1 as const },
    {
      locator: machineScene.locator("div.font-heading", { hasText: /^No machines yet$/ }),
      headingLevel: 2 as const,
    },
    {
      locator: machineScene.locator("div.font-heading", { hasText: /^Machines$/ }),
      headingLevel: 1 as const,
    },
    {
      locator: machineScene.locator("div.font-heading", { hasText: /^Run this on your machine$/ }),
      headingLevel: 3 as const,
    },
  ]

  for (const label of labels) {
    await expect(label.locator).toBeAttached()
    const styles = await typography(label.locator)
    const baseline = await nativeHeadingTypography(page, label.headingLevel)
    expect(styles.fontFamily).toBe(baseline.fontFamily)
    expect(styles.letterSpacingRatio).toBeCloseTo(baseline.letterSpacingRatio, 3)
    expect(styles.lineHeightRatio).toBeCloseTo(baseline.lineHeightRatio, 2)
  }
  expect(pageErrors).toEqual([])
})
