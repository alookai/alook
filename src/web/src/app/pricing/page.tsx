import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata"
import { Suspense } from "react"
import PricingClient from "./pricing-client"

export const metadata = buildPublicPageMetadata({
  title: "Pricing — Free, Studio & House Plans — Alook",
  description:
    "Compare Alook Free, Studio, and House plans for active bots and online machines. Bring your own AI models and agent runtimes.",
  path: "/pricing",
});

export default function PricingPage() {
  return <Suspense fallback={<p role="status" className="p-8">Loading plans…</p>}><PricingClient /></Suspense>
}
