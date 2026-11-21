import { expect, type Locator } from "@playwright/test"
import sharp from "sharp"

function colorDistance(pixel: Buffer, color: number[]) {
  return color.reduce((distance, channel, index) => distance + Math.abs(pixel[index]! - channel), 0)
}

export async function expectPaintedInboxDivider(card: Locator) {
  const divider = card.locator('[data-slot="inbox-card-divider"]')
  await expect(divider).toHaveCSS("height", "1px")
  await expect.poll(async () => {
    const sample = await divider.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const width = 24
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d")!
      const paint = (...colors: string[]) => {
        context.clearRect(0, 0, 1, 1)
        for (const color of colors) {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
        }
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
      }
      const sticky = element.parentElement!
      const surface = getComputedStyle(sticky).backgroundColor
      const line = paint(surface, getComputedStyle(element).backgroundColor)
      const body = paint(surface, getComputedStyle(sticky.nextElementSibling!).backgroundColor)
      return {
        line, body,
        clip: {
          x: Math.floor(rect.left + rect.width / 2 - width / 2 + window.scrollX),
          y: Math.floor(rect.top + window.scrollY) - 1,
          width,
          height: 3,
        },
      }
    })
    expect(sample.line).not.toEqual(sample.body)
    const png = await card.page().screenshot({ clip: sample.clip, scale: "css" })
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let row = 0; row < info.height; row += 1) {
      let matched = 0
      for (let column = 0; column < info.width; column += 1) {
        const offset = (row * info.width + column) * info.channels
        const pixel = data.subarray(offset, offset + info.channels)
        if (colorDistance(pixel, sample.line) <= colorDistance(pixel, sample.body)) matched += 1
      }
      if (matched >= info.width * 0.9) return true
    }
    return false
  }).toBe(true)
}
