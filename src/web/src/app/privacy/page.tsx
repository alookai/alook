import type { Metadata } from "next"
import {
  PRIVACY_POLICY,
  PrivacyPolicyContent,
} from "@/components/privacy/privacy-policy-content"

export const metadata: Metadata = {
  title: PRIVACY_POLICY.title,
  description: PRIVACY_POLICY.description,
  alternates: { canonical: "https://alook.ai/privacy" },
  openGraph: {
    title: `${PRIVACY_POLICY.title} — Alook`,
    description: PRIVACY_POLICY.description,
    url: "https://alook.ai/privacy",
  },
  twitter: {
    card: "summary",
    title: `${PRIVACY_POLICY.title} — Alook`,
    description: PRIVACY_POLICY.description,
  },
}

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-12 pb-28 sm:pt-24">
      <h1 className="mb-4 text-4xl font-semibold tracking-tight sm:text-5xl">
        {PRIVACY_POLICY.title}
      </h1>
      <PrivacyPolicyContent />
    </main>
  )
}
