import { existsSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import { SITE_OG_IMAGE, SITE_OG_IMAGE_URL, siteMetadata } from "@/lib/seo/site-metadata"

const home = new URL("../(home)/", import.meta.url)
const banner = new URL("../../../../../assets/readme/banner.png", import.meta.url)
const card = new URL(`../../../public${SITE_OG_IMAGE_URL}`, import.meta.url)
const background = { r: 244, g: 249, b: 233 }

describe("homepage social images", () => {
  it("serves the same static 1200 by 630 card for Open Graph and Twitter", async () => {
    const og = readFileSync(card)

    expect(SITE_OG_IMAGE_URL).toContain(createHash("sha256").update(og).digest("hex").slice(0, 12))
    expect(siteMetadata.openGraph).toMatchObject({ images: [SITE_OG_IMAGE] })
    expect(siteMetadata.twitter).toMatchObject({ images: [SITE_OG_IMAGE_URL] })
    expect(await sharp(og).metadata()).toMatchObject({ format: "png", width: 1200, height: 630 })
    expect(og.byteLength).toBeLessThan(5 * 1024 * 1024)
    expect(SITE_OG_IMAGE.alt).toBe("Alook — Share your agents with people you trust")
    expect(readFileSync(new URL("page.tsx", home), "utf8").match(/images: \[SITE_OG_IMAGE\]/g)).toHaveLength(2)
    expect(existsSync(new URL("opengraph-image.tsx", home))).toBe(false)
    expect(existsSync(new URL("twitter-image.tsx", home))).toBe(false)
  })

  it("retains the complete current README banner, including its text and paper", async () => {
    const readme = readFileSync(new URL("../../../../../README.md", import.meta.url), "utf8")
    expect(readme.match(/<img\s+src="([^"]+)"/)?.[1]).toBe("./assets/readme/banner.png")
    const expected = await sharp(readFileSync(banner))
      .resize({ width: 1200 })
      .flatten({ background })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const top = Math.floor((630 - expected.info.height) / 2)
    const image = sharp(readFileSync(card))
    const retained = await image.clone()
      .extract({ left: 0, top, width: 1200, height: expected.info.height })
      .removeAlpha()
      .raw()
      .toBuffer()

    expect(retained.equals(expected.data)).toBe(true)
    const padding = await image.clone()
      .extract({ left: 0, top: 0, width: 1200, height: top })
      .removeAlpha()
      .raw()
      .toBuffer()
    for (let index = 0; index < padding.length; index += 3) {
      if (padding[index] !== background.r || padding[index + 1] !== background.g || padding[index + 2] !== background.b) {
        throw new Error("The README banner must be surrounded by its original pale green background")
      }
    }
  })
})
