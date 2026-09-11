import type { Metadata } from "next"
import { Suspense } from "react"
import PricingClient from "./pricing-client"

export const metadata: Metadata = {
  title: { absolute: "Alook Pricing — Free, Studio, and House Plans" },
  description: "Compare Free, Studio, and House plans for your active bots. Bring your own AI models and runtime.",
  alternates: { canonical: "/pricing" },
}

export default function PricingPage() {
  return <Suspense fallback={<p role="status" className="p-8">Loading plans…</p>}><PricingClient /></Suspense>
}
