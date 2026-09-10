import React from "react"
import { describe, expect, it, vi } from "vitest"
import type { BillingSummary } from "@alook/shared"
import { fireEvent, render } from "@/test/react-dom-harness"
import type { BillingController } from "@/hooks/community/use-billing"
import { BillingContent, BillingSheet } from "./billing-sheet"

vi.mock("./billing-plan.module.css", () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))

vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({ open, children, footer }: { open: boolean; children: React.ReactNode; footer: React.ReactNode }) => open ? <div>{children}{footer}</div> : null,
}))

const free: BillingSummary = {
  plan: { id: "free", displayName: "Free" }, isFounder: false, subscription: null,
  offers: [{ priceId: "price_a", plan: { id: "custom-tier", displayName: "Studio" }, botLimit: 10, machineLimit: 5, unitAmount: 2000, currency: "usd", interval: "month", intervalCount: 1 }],
}
function state(overrides: Partial<BillingController> = {}): BillingController {
  return { data: free, isPending: false, isError: false, isFetching: false, isBusy: false, returnFrom: null, polling: false, actionError: null, checkout: vi.fn(), portal: vi.fn(), cancelChange: vi.fn(), isCancelingChange: false, refresh: vi.fn(), ...overrides } as unknown as BillingController
}
function view(billing: BillingController) { return render(<BillingContent billing={billing} />) }

describe("billing sheet", () => {
  it("shows server offers without fixed plan IDs and sends only the selected price", () => {
    const billing = state()
    const ui = view(billing)
    expect(ui.queryByText("Up to 1 online machine")).not.toBeInTheDocument()
    expect(ui.getByText((_text, el) => el?.tagName === "P" && el.textContent === "Up to 5 online machines")).toBeInTheDocument()
    expect(ui.getByText("$20.00 USD / month")).toBeInTheDocument()
    expect(ui.getByText((_text, element) => element?.tagName === "P" && element.textContent === "Up to 10 active bots")).toBeInTheDocument()
    expect(ui.getByRole("img", { name: "10 bot slots" })).toBeInTheDocument()
    fireEvent.click(ui.getByRole("button", { name: "Choose Studio" }))
    expect(billing.checkout).toHaveBeenCalledWith("price_a")
  })
  it("shows Founder paid offers and requires explicit confirmation before checkout", () => {
    const billing = state({ data: { ...free, isFounder: true, plan: { id: "house", displayName: "House" }, offers: [...free.offers, { ...free.offers[0]!, priceId: "price_house", plan: { id: "house", displayName: "House" } }] } })
    const ui = view(billing)
    expect(ui.getByText("Founder")).toBeInTheDocument()
    expect(ui.getByText("Permanent House access")).toBeInTheDocument()
    expect(ui.getByRole("button", { name: "Choose House" })).toBeEnabled()
    fireEvent.click(ui.getByRole("button", { name: "Choose Studio" }))
    expect(ui.getByRole("dialog")).toHaveTextContent("permanently ends your Founder access")
    expect(billing.checkout).not.toHaveBeenCalled()
    fireEvent.click(ui.getByRole("button", { name: "Keep Founder" }))
    expect(billing.checkout).not.toHaveBeenCalled()
    fireEvent.click(ui.getByRole("button", { name: "Choose House" }))
    fireEvent.click(ui.getByRole("button", { name: "Continue to checkout" }))
    expect(billing.checkout).toHaveBeenCalledWith("price_house", true)
    expect(billing.portal).not.toHaveBeenCalled()
  })
  it("keeps Founder while a payment is awaiting confirmation", () => {
    const ui = view(state({ data: { ...free, isFounder: true }, returnFrom: "checkout", polling: true }))
    expect(ui.getByRole("status")).toHaveTextContent("Waiting for payment confirmation")
    expect(ui.getByRole("button", { name: "Choose Studio" })).toBeDisabled()
  })
  it("shows delayed payment honestly and does not invite a second purchase", () => {
    const ui = view(state({ returnFrom: "checkout" }))
    expect(ui.getByRole("status")).toHaveTextContent("Payment confirmation hasn't arrived")
    expect(ui.getByRole("button", { name: "Choose Studio" })).toBeDisabled()
  })
  it("keeps canceled checkout state and provides retry after read/action failures", () => {
    const billing = state({ returnFrom: "cancel", isError: true, actionError: "Couldn't open checkout." })
    const ui = view(billing)
    expect(ui.getByRole("status")).toHaveTextContent("Checkout closed")
    expect(ui.getAllByRole("alert")).toHaveLength(2)
    fireEvent.click(ui.getByRole("button", { name: "Refresh status" }))
    expect(billing.refresh).toHaveBeenCalledOnce()
  })
  it("uses Portal for a subscriber and shows the confirmed next plan and date", () => {
    const billing = state({ data: { ...free, plan: { id: "house", displayName: "House" }, subscription: {
      plan: { id: "house", displayName: "House" }, status: "past_due", cancelAt: null,
      currentPeriodEnd: "2026-10-10T00:00:00Z", scheduledChange: { plan: free.offers[0]!.plan, effectiveAt: "2026-10-10T00:00:00Z" },
    } } })
    const ui = view(billing)
    expect(ui.getByText(/Changes to Studio on/)).toBeInTheDocument()
    expect(ui.getByText(/renewal payment needs attention/)).toBeInTheDocument()
    expect(ui.queryByRole("button", { name: "Choose Studio" })).toBeNull()
    fireEvent.click(ui.getByRole("button", { name: "Manage billing" }))
    expect(billing.portal).toHaveBeenCalledOnce()
  })
  it("keeps period-end cancellation separate from an immediate loss of access", () => {
    const ui = view(state({ data: { ...free, subscription: { plan: free.plan, status: "active", cancelAt: "2026-10-08T00:00:00Z", currentPeriodEnd: "2026-10-10T00:00:00Z", scheduledChange: null } } }))
    expect(ui.getByText(/Ends Oct 8, 2026/)).toBeInTheDocument()
    expect(ui.queryByText(/Current period ends/)).toBeNull()
    expect(ui.getByText(/Your current access stays until then/)).toBeInTheDocument()
  })
  it("shows the billing period again after cancellation is revoked", () => {
    const ui = view(state({ data: { ...free, subscription: { plan: free.plan, status: "active", cancelAt: null, currentPeriodEnd: "2026-10-10T00:00:00Z", scheduledChange: null } } }))
    expect(ui.getByText(/Current period ends Oct 10, 2026/)).toBeInTheDocument()
    expect(ui.queryByText(/Your current access stays until then/)).toBeNull()
  })

  it("lets a subscriber select another tier through the targeted Portal flow", () => {
    const billing = state({ data: { ...free, plan: { id: "house", displayName: "House" }, subscription: {
      plan: { id: "house", displayName: "House" }, status: "active", cancelAt: null, currentPeriodEnd: null, scheduledChange: null,
    } } })
    const ui = view(billing)
    expect(ui.getByRole("img", { name: "10 bot slots" })).toBeInTheDocument()
    fireEvent.click(ui.getByRole("button", { name: "Choose Studio" }))
    expect(billing.portal).toHaveBeenCalledWith("price_a")
    expect(billing.checkout).not.toHaveBeenCalled()
  })

  it("does not send the current price back to Portal when a downgrade is scheduled", () => {
    const house = { id: "house", displayName: "House" }
    const billing = state({ data: { ...free, plan: house, offers: [...free.offers, { ...free.offers[0]!, priceId: "price_house", plan: house, botLimit: 40, unitAmount: 4000 }], subscription: {
      plan: house, status: "active", cancelAt: null, currentPeriodEnd: null,
      scheduledChange: { plan: free.offers[0]!.plan, effectiveAt: "2026-10-10T00:00:00Z" },
    } } })
    const ui = view(billing)
    expect(ui.getByRole("button", { name: "Scheduled" })).toBeDisabled()
    expect(ui.getByRole("button", { name: "Current plan" })).toBeDisabled()
    expect(billing.portal).not.toHaveBeenCalled()
    fireEvent.click(ui.getByRole("button", { name: "Keep current plan" }))
    expect(billing.cancelChange).toHaveBeenCalledOnce()
  })
  it("exposes unavailable offers without a dead purchase button", () => {
    const ui = view(state({ data: { ...free, offers: [] } }))
    expect(ui.getByText(/Paid plans are unavailable/)).toBeInTheDocument()
    expect(ui.queryByRole("button", { name: /Choose/ })).toBeNull()
  })
})

describe("upgrade prompt", () => {
  it("explains the creation block before navigating to plans", () => {
    const close = vi.fn(), plans = vi.fn()
    const ui = render(<BillingSheet open onOpenChange={close} limit={3} onViewPlan={plans} />)
    expect(ui.getByText("Plan limit reached")).toBeInTheDocument()
    expect(ui.getByText(/can’t create another bot/)).toBeInTheDocument()
    expect(plans).not.toHaveBeenCalled()
    fireEvent.click(ui.getByRole("button", { name: "View plan" }))
    expect(close).toHaveBeenCalledWith(false)
    expect(plans).toHaveBeenCalledOnce()
  })
})

it("explains ownership limits without promising an upgrade", () => {
  const ui = render(<BillingSheet open onOpenChange={vi.fn()} limit={40} onViewPlan={vi.fn()} />)
  expect(ui.getByText(/Delete bots until you own fewer than 40/)).toBeInTheDocument()
  expect(ui.getByRole("button", { name: "View plan" })).toBeInTheDocument()
  expect(ui.queryByText(/upgrade your plan/i)).toBeNull()
  expect(ui.getByRole("button", { name: "Got it" })).toBeInTheDocument()
})
