import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import TermsPage, { metadata } from "@/app/terms/page"
import { TERMS_OF_SERVICE } from "@/lib/terms"
import { TermsContent } from "./terms-content"

vi.mock("@/lib/observability/regions", () => ({ ObservedStaticContent: () => null }))

describe("Terms of Service", () => {
  it("renders public terms with the shared body, company, limited rights and independent privacy link", () => {
    const body = renderToStaticMarkup(createElement(TermsContent))
    const page = renderToStaticMarkup(createElement(TermsPage))
    expect(page).toContain(body)
    expect(body).toContain(`data-terms-version="${TERMS_OF_SERVICE.version}"`)
    expect(body).toContain("MEMODB PTE. LTD.")
    expect(body).toContain('href="mailto:support@alook.ai"')
    expect(body).toContain("You keep your rights")
    expect(body).toContain("does not give")
    expect(body).toContain("use it to train models")
    expect(body).toContain("retroactively")
    expect(body).toContain('href="/privacy"')
    expect(body).toContain("does not enable optional analytics")
    expect(body).not.toContain("governing law")
    expect(body).not.toContain("report button")
  })

  it("uses the same content in its own Settings tab and keeps public sharing metadata canonical", () => {
    const settings = readFileSync(new URL("../community/settings/user-settings.tsx", import.meta.url), "utf8")
    expect(settings).toContain('{ value: "terms", label: "Terms", icon: FileText }')
    expect(settings).toContain('<SettingsShellPanel value="terms">')
    expect(settings).toContain("<TermsContent />")
    expect(settings).toContain("<PrivacyPolicyContent />")
    expect(metadata.alternates).toMatchObject({ canonical: "https://alook.ai/terms" })
    expect(metadata.openGraph).toMatchObject({ url: "https://alook.ai/terms", title: `${TERMS_OF_SERVICE.title} — Alook` })
  })
})
