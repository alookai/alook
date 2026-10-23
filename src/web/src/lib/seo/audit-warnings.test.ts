import { describe, expect, it, vi } from "vitest"
import { TEMPLATES } from "@/lib/templates"

vi.mock("@/lib/session", () => ({ getSession: () => { throw new Error("Public documents must not wait for an account session") } }))
vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }))
vi.mock("@/app/templates/client", () => ({ TemplatesClient: () => null }))
vi.mock("@/app/templates/[id]/client", () => ({ TemplateDetailClient: () => null }))
vi.mock("@/components/privacy/privacy-policy-content", () => ({ PRIVACY_POLICY: { title: "Privacy Policy" }, PrivacyPolicyContent: () => null }))

import { metadata as contact } from "@/app/contact/page"
import { metadata as privacy } from "@/app/privacy/page"
import TemplatesPage, { metadata as templates } from "@/app/templates/page"
import TemplatePage, { generateMetadata, generateStaticParams } from "@/app/templates/[id]/page"

const SITE = "https://alook.ai"

describe("audit warning repairs", () => {
  it.each([[contact, "/contact"], [privacy, "/privacy"]] as const)("aligns a public page's complete sharing data with its canonical", (metadata, path) => {
    expect(metadata.alternates?.canonical).toBe(SITE + path)
    expect(metadata.openGraph).toMatchObject({ type: "website", url: SITE + path, description: metadata.description, images: expect.any(Array) })
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", description: metadata.description, images: expect.any(Array) })
    expect(metadata.description!.length).toBeGreaterThanOrEqual(100)
  })

  it("declares the template directory's OG type", () => {
    expect(templates.openGraph).toMatchObject({ type: "website", url: SITE + "/templates" })
  })

  it("renders public templates without reading a server account session", async () => {
    expect(await TemplatesPage()).toBeTruthy()
    expect(generateStaticParams()).toEqual(TEMPLATES.map(t => ({ id: t.id })))
    for (const template of TEMPLATES) {
      const params = Promise.resolve({ id: template.id })
      const metadata = await generateMetadata({ params })
      expect(metadata.openGraph).toMatchObject({ type: "website", url: `${SITE}/templates/${template.id}` })
      expect(metadata.description!.length).toBeGreaterThanOrEqual(100)
      const page = await TemplatePage({ params })
      const json = JSON.parse(page.props.children[1].props.children[0].props.dangerouslySetInnerHTML.__html)
      expect(json[0]).toMatchObject({ "@type": "CreativeWork", url: `${SITE}/templates/${template.id}`, description: template.longDescription })
      expect(json[0]).not.toHaveProperty("offers")
      expect(json[1]["@type"]).toBe("BreadcrumbList")
    }
  })

  it("preserves not-found handling for unknown templates", async () => {
    const params = Promise.resolve({ id: "missing-template" })
    expect(await generateMetadata({ params })).toEqual({ title: "Not Found" })
    await expect(TemplatePage({ params })).rejects.toThrow()
  })
})
