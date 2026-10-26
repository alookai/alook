import { ObservedStaticContent } from "@/lib/observability/regions"
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"
import { TERMS_OF_SERVICE } from "@/lib/terms"
import { TermsContent } from "@/components/terms/terms-content"

export const metadata = buildPublicPageMetadata({
  title: `${TERMS_OF_SERVICE.title} — Alook`,
  description: "Read Alook’s Terms of Service, including your account responsibilities, content rights and acceptable use.",
  path: "/terms",
})

export default function TermsPage() {
  return (
    <><ObservedStaticContent /><main className="mx-auto max-w-3xl px-6 pt-12 pb-28 sm:pt-24">
      <h1 className="mb-4 text-4xl font-semibold tracking-tight sm:text-5xl">{TERMS_OF_SERVICE.title}</h1>
      <TermsContent />
    </main></>
  )
}
