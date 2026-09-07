import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  PRIVACY_POLICY,
  PrivacyPolicyContent,
} from "./privacy-policy-content"

describe("shared Privacy policy", () => {
  it("preserves the published policy copy and update date", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPolicyContent))

    expect(html).toContain(`data-privacy-policy="${PRIVACY_POLICY.lastUpdated}"`)
    expect(html).toContain(`Last updated: ${PRIVACY_POLICY.lastUpdated}`)
    expect(html).toContain("Interpretation and Definitions")
    expect(html).toContain("Collecting and Using Your Personal Data")
    expect(html).toContain("Your Data Rights")
    expect(html).toContain("support@alook.ai")
    expect(html).not.toContain("durable background job")
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
