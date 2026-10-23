import { ObservedStaticContent } from "@/lib/observability/regions";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"
import {
  PRIVACY_POLICY,
  PrivacyPolicyContent,
} from "@/components/privacy/privacy-policy-content"

export const metadata = buildPublicPageMetadata({
  title: `${PRIVACY_POLICY.title} — Alook`,
  description: "Read how Alook collects, uses, stores, and protects personal information, including account data, cookies, analytics choices, and your privacy rights.",
  path: "/privacy",
})

export default function PrivacyPage() {
  return (
    <><ObservedStaticContent /><main className="mx-auto max-w-3xl px-6 pt-12 pb-28 sm:pt-24">
      <h1 className="mb-4 text-4xl font-semibold tracking-tight sm:text-5xl">
        {PRIVACY_POLICY.title}
      </h1>
      <PrivacyPolicyContent showAnalyticsChoices />
    </main></>
  )
}
