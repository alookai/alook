import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import type { PublicPricing } from "@alook/shared"
import { fn } from "storybook/test"
import { PricingView } from "@/app/pricing/pricing-view"
import type { PricingController } from "@/app/pricing/pricing-client"

const catalog: PublicPricing = {
  free: { plan: { id: "free", displayName: "Free" }, botLimit: 2, machineLimit: 1 },
  offers: [
    { priceId: "preview-house", botLimit: 5, machineLimit: 2, plan: { id: "house", displayName: "House" }, unitAmount: 1200, currency: "usd", interval: "month", intervalCount: 1 },
    { priceId: "preview-studio", botLimit: 15, machineLimit: 5, plan: { id: "studio", displayName: "Studio" }, unitAmount: 3900, currency: "usd", interval: "month", intervalCount: 1 },
  ],
}
function PricingExample({ state = "ready" }: { state?: "ready" | "loading" | "error" }) {
  const controller: PricingController = { catalog: state === "ready" ? catalog : undefined, offer: (plan) => state === "ready" ? catalog.offers.find((offer) => offer.plan.id === plan) : undefined, disabled: () => state !== "ready", label: () => state === "loading" ? "Loading…" : "Choose plan", choose: fn(), message: "Local preview data; amounts are examples.", error: state === "error" ? "Could not load plans." : null, retry: fn() }
  return <PricingView controller={controller} />
}
const meta = { title: "Web/Pages/Pricing", component: PricingExample, tags: ["autodocs", "ai-generated"], parameters: { layout: "fullscreen" }, args: { state: "ready" }, argTypes: { state: { control: "select", options: ["ready", "loading", "error"] } } } satisfies Meta<typeof PricingExample>
export default meta
type Story = StoryObj<typeof meta>
export const Plans: Story = {}
export const Loading: Story = { args: { state: "loading" } }
export const Unavailable: Story = { args: { state: "error" } }
