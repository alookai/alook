"use client"

import { useEffect, useRef, useState, type MutableRefObject } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { PublicPricingSchema, type PublicPricing, type BillingOffer } from "@alook/shared"
import { useSession } from "@/lib/auth-client"
import { apiFetch } from "@/lib/api/client"
import { useBilling } from "@/hooks/community/use-billing"
import { FounderPlanChangeDialog } from "@/components/community/billing/founder-plan-change-dialog"
import { toAnalyticsCurrentPlan, toAnalyticsPlanId, trackPricingCtaClick, trackPricingView, type PricingCtaAction } from "@/lib/analytics"
import { PricingView } from "./pricing-view"

function PricingContent({ signedIn, sessionPending, sessionError, viewTrackedRef }: {
  signedIn: boolean
  sessionPending: boolean
  sessionError: boolean
  viewTrackedRef: MutableRefObject<boolean>
}) {
  const router = useRouter()
  const search = useSearchParams()
  const catalog = useQuery({
    queryKey: ["public-pricing"],
    queryFn: async ({ signal }) => PublicPricingSchema.parse(await apiFetch<unknown>("/api/pricing", { signal })),
    staleTime: 30_000,
    retry: false,
  })
  const billing = useBilling(null, signedIn)
  const summary = signedIn ? billing.data : undefined
  const [founderOffer, setFounderOffer] = useState<BillingOffer | null>(null)
  const paymentOffer = (plan: string) => summary?.offers.find((item) => item.plan.id === plan)
  const offer = (plan: string) => paymentOffer(plan) ?? catalog.data?.offers.find((item) => item.plan.id === plan)
  const selected = offer(search.get("plan") ?? "")
  const busy = sessionPending || billing.isBusy || catalog.isPending || (signedIn && billing.isPending)
  const unavailable = sessionError || catalog.isError || (signedIn && billing.isError)
  const disabled = (plan: string) => busy || unavailable || (plan !== "free" && (
    !offer(plan) || (signedIn && !paymentOffer(plan)) || (!summary?.isFounder && summary?.plan.id === plan) || summary?.subscription?.scheduledChange?.plan.id === plan
  ))
  const currentPlan = signedIn && summary ? toAnalyticsCurrentPlan(summary.plan.id, summary.isFounder) : "none"
  useEffect(() => {
    if (viewTrackedRef.current || !catalog.data || sessionPending || sessionError || (signedIn && !summary)) return
    viewTrackedRef.current = true
    trackPricingView({ auth_state: signedIn ? "signed_in" : "guest", current_plan: currentPlan })
  }, [catalog.data, currentPlan, sessionError, sessionPending, signedIn, summary, viewTrackedRef])
  const label = (plan: string) => {
    if (busy) return "Loading…"
    if (plan === "free") return summary?.subscription && !summary.isFounder ? "Manage cancellation" : signedIn ? "Open Alook" : "Start free"
    if (summary?.subscription?.scheduledChange?.plan.id === plan) return "Scheduled"
    if (!summary?.isFounder && summary?.plan.id === plan) return "Current plan"
    const item = offer(plan)
    return item ? `Choose ${item.plan.displayName}` : "Unavailable"
  }
  const choose = (plan: string) => {
    if (disabled(plan)) return
    const planId = toAnalyticsPlanId(plan)
    if (planId) {
      const action: PricingCtaAction = planId !== "free" ? "choose_plan"
        : !signedIn ? "start_free"
        : summary?.subscription && !summary.isFounder ? "manage_cancellation" : "open_app"
      trackPricingCtaClick({
        plan_id: planId,
        cta_action: action,
        auth_state: signedIn ? "signed_in" : "guest",
        current_plan: currentPlan,
        entry_point: "pricing_page",
      })
    }
    if (!signedIn) {
      const destination = plan === "free" ? "/c/me/bots" : `/pricing?${new URLSearchParams({ plan })}`
      router.push(`/sign-in?${new URLSearchParams({ redirect: destination })}`)
      return
    }
    if (plan === "free") {
      if (summary?.subscription && !summary.isFounder) void billing.portal()
      else router.push("/c/me/bots")
      return
    }
    const item = paymentOffer(plan)
    if (!item) return
    if (summary?.isFounder) { setFounderOffer(item); return }
    void (summary?.subscription ? billing.portal(item.priceId) : billing.checkout(item.priceId, false, "pricing_page"))
  }
  const message = summary?.isFounder
    ? `Your Founder plan includes permanent ${summary.plan.displayName} access.`
    : selected ? `${selected.plan.displayName} selected. Choose it below to continue.`
    : summary ? `Your current plan: ${summary.plan.displayName}.` : ""
  const error = sessionError ? "Couldn't check your sign-in status. Reload this page to try again."
    : unavailable ? "Couldn't load plans. Try again before choosing a plan."
    : billing.actionError
  const retry = () => {
    if (sessionError) { window.location.reload(); return }
    void catalog.refetch()
    if (signedIn) billing.refresh()
  }
  return <>
    <PricingView controller={{ catalog: catalog.data, offer, disabled, label, choose, message, error, retry }} />
    <FounderPlanChangeDialog offer={founderOffer} busy={billing.isBusy} onCancel={() => setFounderOffer(null)} onConfirm={() => {
      if (!founderOffer || disabled(founderOffer.plan.id)) return
      const current = paymentOffer(founderOffer.plan.id)
      if (!current || current.priceId !== founderOffer.priceId) { setFounderOffer(null); return }
      setFounderOffer(null)
      void billing.checkout(current.priceId, true, "pricing_page")
    }} />
  </>
}

export type PricingController = {
  catalog: PublicPricing | undefined
  offer: (plan: string) => BillingOffer | undefined
  disabled: (plan: string) => boolean
  label: (plan: string) => string
  choose: (plan: string) => void
  message: string
  error: string | null
  retry: () => void
}

function PricingSession({ signedIn, sessionPending, sessionError, viewTrackedRef }: {
  signedIn: boolean
  sessionPending: boolean
  sessionError: boolean
  viewTrackedRef: MutableRefObject<boolean>
}) {
  const [client] = useState(() => new QueryClient())
  return <QueryClientProvider client={client}><PricingContent signedIn={signedIn} sessionPending={sessionPending} sessionError={sessionError} viewTrackedRef={viewTrackedRef} /></QueryClientProvider>
}

export default function PricingClient() {
  const session = useSession()
  const viewTrackedRef = useRef(false)
  return <PricingSession key={session.data?.user.id ?? "guest"} signedIn={Boolean(session.data?.user)} sessionPending={session.isPending} sessionError={Boolean(session.error)} viewTrackedRef={viewTrackedRef} />
}
