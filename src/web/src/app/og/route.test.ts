import { describe, expect, it } from "vitest"
import { SITE_OG_IMAGE_URL } from "@/lib/seo/site-metadata"
import { GET } from "./route"

describe("legacy brand image", () => {
  it.each(["https://alook.ai", "http://localhost:3000"])("uses the new card on %s", (origin) => {
    const response = GET(new Request(`${origin}/og?title=obsolete&image=https://example.com/private`))

    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe(`${origin}${SITE_OG_IMAGE_URL}`)
  })
})
