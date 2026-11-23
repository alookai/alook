import { expect, type Locator } from "@playwright/test"
import sharp from "sharp"

function colorDistance(pixel: Buffer, color: ArrayLike<number>) {
  return Math.abs(pixel[0]! - color[0]!) + Math.abs(pixel[1]! - color[1]!) + Math.abs(pixel[2]! - color[2]!)
}

export async function expectSeamlessInboxCard(card: Locator) {
  await expect(card.locator('[data-slot="inbox-card-divider"]')).toHaveCount(0)
  const header = card.locator('[data-slot="inbox-card-header"]')
  await expect(header).toHaveAttribute("data-expanded", "true")
  await expect.poll(async () => {
    const sample = await header.evaluate(element => {
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
      const headerColor = paint(surface, getComputedStyle(element).backgroundColor)
      const bodyColor = paint(surface, getComputedStyle(sticky.nextElementSibling!).backgroundColor)
      return {
        headerColor,
        bodyColor,
        clip: {
          x: Math.floor(rect.left + rect.width / 2 - width / 2 + window.scrollX),
          y: Math.floor(rect.bottom + window.scrollY) - 1,
          width,
          height: 3,
        },
      }
    })
    expect(sample.headerColor).toEqual(sample.bodyColor)
    const png = await card.page().screenshot({ clip: sample.clip, scale: "css" })
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let row = 0; row < info.height; row += 1) {
      let matched = 0
      for (let column = 0; column < info.width; column += 1) {
        const offset = (row * info.width + column) * info.channels
        const pixel = data.subarray(offset, offset + info.channels)
        if (colorDistance(pixel, sample.headerColor) <= 4) matched += 1
      }
      if (matched < info.width * 0.9) return false
    }
    return true
  }).toBe(true)
}

export async function expectPaintedInboxCardSurface(card: Locator) {
  const header = card.locator('[data-slot="inbox-card-header"]')
  await expect(header).toHaveCSS("border-width", "0px")
  await expect(header).toHaveCSS("border-bottom-left-radius", /^[1-9]\d*(?:\.\d+)?px$/)
  await expect(header).toHaveCSS("border-bottom-right-radius", /^[1-9]\d*(?:\.\d+)?px$/)
  await expect.poll(async () => {
    const clip = await header.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const width = 24
      return {
        x: Math.floor(rect.left + rect.width / 2 - width / 2 + window.scrollX),
        y: Math.floor(rect.bottom + window.scrollY) - 8,
        width,
        height: 12,
      }
    })
    const png = await card.page().screenshot({ clip, scale: "css" })
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const rowBytes = info.width * info.channels
    let matched = 0
    for (let column = 0; column < info.width; column += 1) {
      const offset = column * info.channels
      const pixel = (row: number) => data.subarray(row * rowBytes + offset, row * rowBytes + offset + info.channels)
      const interior = pixel(0)
      const edge = pixel(4)
      const outside = pixel(info.height - 1)
      if (colorDistance(edge, interior) <= 4 && colorDistance(outside, interior) > 4) matched += 1
    }
    return matched >= info.width * 0.9
  }).toBe(true)
}
