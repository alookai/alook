"use client"

import { ensureBrowserAnalyticsIdentity } from "@/lib/product-analytics-identity"
import { isTauri } from "@alook/shared"
import { readAnalyticsConsent } from "@/lib/analytics-consent"

export type ProductAnalyticsInput =
  | { event: "landing_cta_clicked"; ctaName: string }
  | { event: "login_page_view" }
  | { event: "sign_in_failed"; method: "email_otp" | "github" | "google" | "apple"; failureStage: "send_code" | "verify_code" | "social_start" }
  | { event: "onboarding_enter_clicked"; serverId: string }
  | { event: "invitation_link_visit"; token: string }

export async function captureProductAnalytics(input: ProductAnalyticsInput, requestId = crypto.randomUUID()): Promise<void> {
  if (typeof window === "undefined" || isTauri() || readAnalyticsConsent() === "denied") return
  ensureBrowserAnalyticsIdentity()
  try {
    await fetch("/api/community/analytics/product-events", {
      method: "POST", credentials: "include", keepalive: true,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {}
}
