import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  PRIVACY_POLICY,
  PrivacyPolicyContent,
} from "./privacy-policy-content"

describe("shared Privacy policy", () => {
  it("preserves the shared policy and identifies the implementation date", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPolicyContent))

    expect(html).toContain(`data-privacy-policy="${PRIVACY_POLICY.lastUpdated}"`)
    expect(html).toContain(`Last updated: ${PRIVACY_POLICY.lastUpdated}`)
    expect(PRIVACY_POLICY.lastUpdated).toBe("October 10, 2026")
    expect(html).toContain("Interpretation and Definitions")
    expect(html).toContain("Collecting and Using Your Personal Data")
    expect(html).toContain("Your Data Rights")
    expect(html).toContain("support@alook.ai")
    expect(html).not.toContain("durable background job")
    expect(html).toContain("even without analytics cookies")
    expect(html).toContain("other optional analytics")
    expect(html).toContain("180 days")
    expect(html).toContain("Google still receives signals without analytics cookies")
    expect(html).not.toContain("keeps Google Tag Manager and")
    expect(html).not.toContain("collected only after")
  })

  it("places analytics preferences after the policy content", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPolicyContent))

    expect(html.indexOf("Analytics choices")).toBeGreaterThan(html.indexOf("Contact Us"))
    expect(html).toContain('<div class="mt-12"><section id="analytics-choices"')
    expect(html).toContain("using the preference control below at any time")
  })

  it("is the body source for both public and Settings entry points", () => {
    const publicPage = readFileSync(new URL("../../app/privacy/page.tsx", import.meta.url), "utf8")
    const userSettings = readFileSync(
      new URL("../community/settings/user-settings.tsx", import.meta.url),
      "utf8",
    )

    for (const source of [publicPage, userSettings]) {
      expect(source).toContain("PrivacyPolicyContent")
      expect(source).not.toContain("iframe")
    }
    expect(publicPage).toContain("PRIVACY_POLICY.title")
    expect(publicPage).toContain("openGraph")
  })
})
