import { test, expect } from "./_fixtures/community-fixture"
import { expectUniqueSsrInitialFrame } from "./_fixtures/community-ssr-frame"
import { tid } from "./_fixtures/testids"
import {
  runAndroidLoadingGeometry,
  runSkeletonLoadingMotion,
} from "./_fixtures/community-loading-geometry"

test.describe.serial("community Android loading geometry", () => {
  test("Android Chrome/WebView keep parsed SSR layouts mobile before application JS and through hydration", async ({ asUser }, testInfo) => {
    test.setTimeout(240_000)
    await runAndroidLoadingGeometry(asUser, testInfo)
  })

  test("community skeleton pulse changes only opacity and stops for reduced motion", async ({ asUser }) => {
    await runSkeletonLoadingMotion(asUser)
  })
})

const frameHtml = (owner: string) => (
  `<div data-testid="${tid.initialFrame}" data-owner="${owner}" style="width:100px;height:100px"></div>`
)

test("SSR fixture requires a visible initial frame", async ({ page }) => {
  await page.setContent(frameHtml("visible"))
  const frame = await expectUniqueSsrInitialFrame(page)
  await expect(frame).toHaveAttribute("data-owner", "visible")
})

for (const streamFirst of [false, true]) {
  test(`SSR fixture classifies a hidden stream ${streamFirst ? "before" : "after"} the visible frame`, async ({ page }) => {
    const fallback = frameHtml("fallback")
    const stream = `<div hidden id="S:0">${frameHtml("stream")}</div>`
    await page.setContent(streamFirst ? stream + fallback : fallback + stream)
    const initialFrame = await expectUniqueSsrInitialFrame(page)
    await expect(initialFrame).toHaveAttribute("data-owner", "fallback")
    await expect(page.getByTestId(tid.initialFrame)).toHaveCount(2)
    await page.evaluate(() => {
      document.querySelector('[data-owner="fallback"]')!.remove()
      const segment = document.getElementById("S:0")!
      segment.replaceWith(...segment.childNodes)
    })
    const promotedFrame = await expectUniqueSsrInitialFrame(page)
    await expect(promotedFrame).toHaveAttribute("data-owner", "stream")
    await promotedFrame.evaluate((element) => element.remove())
    await expect(page.getByTestId(tid.initialFrame)).toHaveCount(0)
  })
}

test("SSR fixture rejects two visible frames without waiting for retirement", async ({ page }) => {
  await page.setContent(frameHtml("fallback") + frameHtml("duplicate"))
  await expect(expectUniqueSsrInitialFrame(page)).rejects.toThrow(
    "SSR must have exactly one visible initial frame",
  )
  await expect(page.getByTestId(tid.initialFrame)).toHaveCount(2)
})

test("SSR fixture rejects a stream copy without a hidden container", async ({ page }) => {
  await page.setContent(frameHtml("fallback") + `<div id="S:0">${frameHtml("stream")}</div>`)
  await expect(expectUniqueSsrInitialFrame(page)).rejects.toThrow(
    "SSR must have exactly one visible initial frame",
  )
})

test("SSR fixture rejects an unexplained hidden frame", async ({ page }) => {
  await page.setContent(frameHtml("fallback") + `<div hidden>${frameHtml("unknown")}</div>`)
  await expect(expectUniqueSsrInitialFrame(page)).rejects.toThrow(
    "Unexpected hidden SSR initial frame",
  )
})
