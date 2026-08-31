import { describe, expect, it } from "vitest"
import { BRAND_DESCRIPTION, BRAND_TITLE } from "../brand-copy"
import {
  SITE_OG_IMAGE_URL,
  SITE_URL,
  siteMetadata,
  siteStructuredData,
  siteViewport,
} from "./site-metadata"

describe("canonical site metadata", () => {
  it("keeps the shared main and Blog shell defaults in one contract", () => {
    expect(SITE_URL).toBe("https://alook.ai")
    expect(SITE_OG_IMAGE_URL).toBe("/og")
    expect(siteMetadata.metadataBase).toEqual(new URL(SITE_URL))
    expect(siteMetadata.title).toMatchObject({ default: BRAND_TITLE, template: "%s — Alook" })
    expect(siteMetadata.description).toBe(BRAND_DESCRIPTION)
    expect(siteMetadata.alternates).toMatchObject({
      canonical: SITE_URL,
      types: { "text/markdown": "/llms.txt" },
    })
    expect(siteViewport).toMatchObject({ width: "device-width", maximumScale: 1 })
    expect(siteStructuredData.map((entry) => entry["@type"])).toEqual([
      "WebApplication",
      "Organization",
    ])
  })
})
