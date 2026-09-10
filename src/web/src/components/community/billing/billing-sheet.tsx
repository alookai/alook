"use client"

import { useState } from "react"
import { FounderPlanChangeDialog } from "./founder-plan-change-dialog"
import { ExternalLink, RefreshCw } from "lucide-react"
import type { BillingSummary } from "@alook/shared"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { BillingController } from "@/hooks/community/use-billing"
import { PlanBotDots } from "@/components/pricing/plan-bot-dots"
import styles from "./billing-plan.module.css"
import { tid } from "@/lib/community/testids"

function formatOffer(offer: BillingSummary["offers"][number]) {
  const currency = offer.currency.toUpperCase()
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2
  const amount = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(offer.unitAmount / 10 ** digits)
  const period = offer.intervalCount === 1 ? offer.interval : `${offer.intervalCount} ${offer.interval}s`
  return `${amount} ${currency} / ${period}`
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value))
}

export function BillingContent({ billing }: { billing: BillingController }) {
  const [founderOffer, setFounderOffer] = useState<BillingSummary["offers"][number] | null>(null)
  const summary = billing.data
  const subscription = summary?.isFounder ? null : summary?.subscription
  const currentOffer = summary?.offers.find((offer) => offer.plan.id === summary.plan.id)
  const checkoutPending = billing.returnFrom === "checkout" && (summary?.isFounder || !subscription || subscription.plan.id !== summary?.plan.id)

  return <div className={styles.content} data-testid={tid.billingSheet}>
    <section className="pb-2" aria-label="Current plan">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          {billing.isPending && <Skeleton className="h-14 w-36" aria-label="Loading billing" />}
          {summary && <div className="flex flex-wrap items-start gap-2">
            <h2 className={styles.currentName}>{summary.isFounder ? "Founder" : summary.plan.displayName}</h2>
            <span className="mt-1 rounded-md bg-muted px-2 py-1 text-xs font-medium leading-none text-muted-foreground">Current</span>
          </div>}
        </div>
        <Button variant="ghost" size="icon-sm" className="size-11 shrink-0 text-muted-foreground sm:size-8" onClick={billing.refresh} disabled={billing.isFetching} aria-label="Refresh status" data-testid={tid.billingRefresh}>
          <RefreshCw className={`size-4 ${billing.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </Button>
      </div>
      {summary && <>
        {(summary.isFounder || currentOffer || subscription) && <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {summary.isFounder ? <p className="text-sm text-muted-foreground">Permanent {summary.plan.displayName} access</p> : currentOffer && <p className="text-sm text-muted-foreground">{formatOffer(currentOffer)}</p>}
          {subscription && !summary.isFounder && <Button variant="outline" onClick={() => void billing.portal()} disabled={billing.isBusy} data-testid={tid.billingPortal}>Manage billing<ExternalLink className="size-3.5" /></Button>}
        </div>}
        {(subscription?.scheduledChange || subscription?.cancelAt || subscription?.currentPeriodEnd || subscription?.status === "past_due") && <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 text-sm">
          {subscription?.scheduledChange && <div className="flex flex-wrap items-center justify-between gap-3">
            <p>Changes to {subscription.scheduledChange.plan.displayName} on {dateLabel(subscription.scheduledChange.effectiveAt)}</p>
            {!summary.isFounder && <Button variant="outline" size="sm" onClick={() => void billing.cancelChange()} disabled={billing.isBusy} data-testid={tid.billingCancelChange}>{billing.isCancelingChange ? "Keeping current plan…" : "Keep current plan"}</Button>}
          </div>}
          {subscription?.cancelAt && <p>Ends {dateLabel(subscription.cancelAt)}. Your current access stays until then.</p>}
          {subscription && !subscription.cancelAt && !subscription.scheduledChange && subscription.currentPeriodEnd && <p className="text-muted-foreground">Current period ends {dateLabel(subscription.currentPeriodEnd)}</p>}
          {subscription?.status === "past_due" && <p>Your renewal payment needs attention. Update your payment method in billing management.</p>}
        </div>}
      </>}
    </section>
    {billing.isError && <p role="alert" className="text-sm text-destructive">Couldn&apos;t refresh your plan. Check your connection and refresh status.</p>}
    {billing.returnFrom && <p role="status" className="text-sm text-muted-foreground">
      {billing.returnFrom === "cancel" ? "Checkout closed. Your current plan is shown above." : checkoutPending ? billing.polling ? "Waiting for payment confirmation. Your current access stays in place." : "Payment confirmation hasn't arrived yet. Refresh status to check again." : billing.polling ? "Refreshing your plan and billing status…" : "Your current plan is shown above. Refresh status to check for further changes."}
    </p>}
    {summary && <section className="flex flex-col gap-4" aria-label="Available plans">
      <h2 className="text-base font-medium">{subscription ? "Change plan" : "Choose a plan"}</h2>
      {summary.offers.length === 0 && <p className="text-sm text-muted-foreground">Paid plans are unavailable right now. Refresh status to try again.</p>}
      <div className={styles.offers}>
        {summary.offers.map((offer) => {
          const isCurrent = Boolean(subscription && offer.plan.id === summary.plan.id)
          const isScheduled = subscription?.scheduledChange?.plan.id === offer.plan.id
          return <article key={offer.priceId} className={`${styles.offer} ${offer.plan.id === "house" ? styles.house : styles.studio}`}>
            <div className="flex flex-col gap-2">
              <h3 className={styles.name}>{offer.plan.displayName}</h3>
              <p className={styles.price}>{formatOffer(offer)}</p>
            </div>
            <p className={styles.limit}>Up to <strong>{offer.botLimit}</strong> active bots</p>
            <Button className={styles.action} variant={isCurrent || isScheduled ? "outline" : "default"} onClick={() => { if (summary.isFounder) setFounderOffer(offer); else void (subscription ? billing.portal(offer.priceId) : billing.checkout(offer.priceId)) }} disabled={billing.isBusy || Boolean(checkoutPending) || isCurrent || isScheduled} data-testid={subscription ? tid.billingChangePlan : tid.billingCheckout} data-price-id={offer.priceId}>
              {billing.isBusy && !billing.isCancelingChange ? "Opening…" : isScheduled ? "Scheduled" : isCurrent ? "Current plan" : `Choose ${offer.plan.displayName}`}
            </Button>
            <div className={styles.stub}><span>Alook · {offer.botLimit} bots</span><PlanBotDots count={offer.botLimit} className={styles.botDots} /></div>
          </article>
        })}
      </div>
      <p className="text-xs text-muted-foreground">{subscription ? "Review changes and any payment on Stripe." : "Continue to Stripe to review and pay."}</p>
    </section>}
    <FounderPlanChangeDialog offer={founderOffer} busy={billing.isBusy} onCancel={() => setFounderOffer(null)} onConfirm={() => { if (!founderOffer) return; const priceId = founderOffer.priceId; setFounderOffer(null); void billing.checkout(priceId, true) }} />
    {billing.actionError && <p role="alert" className="text-sm text-destructive">{billing.actionError}</p>}
  </div>
}

export function BillingSheet({ open, onOpenChange, limit, onViewPlan }: { open: boolean; onOpenChange: (open: boolean) => void; limit: number; onViewPlan: () => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md" data-testid="upgrade-plan-modal">
      <DialogHeader>
        <DialogTitle>Plan limit reached</DialogTitle>
        <DialogDescription>Your owned bots have reached your plan’s limit of {limit}. You can’t create another bot. Delete bots until you own fewer than {limit} to make room.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>Got it</Button>
        <Button onClick={() => { onOpenChange(false); onViewPlan() }}>View plan</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
