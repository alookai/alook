import { beforeEach, expect, it, vi } from "vitest"
import { render, setupUser, waitFor } from "@/test/react-dom-harness"
import PricingClient from "./pricing-client"

vi.mock("./pricing.module.css", () => ({ default: new Proxy({}, { get: (_target, key) => String(key) }) }))

const state = vi.hoisted(() => ({
  session: { data: null as null | { user: { id: string } }, isPending: false, error: null },
  search: new URLSearchParams(),
  push: vi.fn(), api: vi.fn(), checkout: vi.fn(), portal: vi.fn(), refresh: vi.fn(),
  billing: {} as Record<string, unknown>,
}))
vi.mock("@/lib/auth-client", () => ({ useSession: () => state.session }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }), useSearchParams: () => state.search }))
vi.mock("@/lib/api/client", () => ({ apiFetch: state.api }))
vi.mock("@/hooks/community/use-billing", () => ({ useBilling: () => ({ ...state.billing, checkout: state.checkout, portal: state.portal, refresh: state.refresh }) }))

const offers = [
  { plan: { id: "studio", displayName: "Studio" }, botLimit: 10, machineLimit: 5, priceId: "price_server_studio", unitAmount: 2000, currency: "usd", interval: "month", intervalCount: 1 },
  { plan: { id: "house", displayName: "House" }, botLimit: 40, machineLimit: 10, priceId: "price_server_house", unitAmount: 4000, currency: "usd", interval: "month", intervalCount: 1 },
]
const catalog = { free: { plan: { id: "free", displayName: "Free" }, botLimit: 3, machineLimit: 1 }, offers }
const free = { plan: catalog.free.plan, isFounder: false, subscription: null, offers }
const subscription = { plan: offers[0].plan, status: "active", currentPeriodEnd: null, cancelAt: null, scheduledChange: null }

beforeEach(() => {
  vi.clearAllMocks()
  state.session = { data: null, isPending: false, error: null }
  state.search = new URLSearchParams()
  state.api.mockResolvedValue(catalog)
  state.billing = { data: undefined, isPending: false, isBusy: false, isError: false, actionError: null }
})

it("sends guests to sign-in with a valid selected plan preserved", async () => {
  const view = render(<PricingClient />)
  await setupUser().click(await view.findByRole("button", { name: "Choose Studio" }))
  const url = new URL(state.push.mock.calls[0][0], "https://alook.ai")
  expect(url.pathname).toBe("/sign-in")
  expect(url.searchParams.get("redirect")).toBe("/pricing?plan=studio")
  expect(state.checkout).not.toHaveBeenCalled()
})

it("preserves selected plan after sign-in without automatically starting payment", async () => {
  state.session.data = { user: { id: "buyer" } }
  state.billing.data = free
  state.search = new URLSearchParams({ plan: "studio", priceId: "price_attacker" })
  const view = render(<PricingClient />)
  expect(await view.findByText("Studio selected. Choose it below to continue.")).toBeInTheDocument()
  expect(state.checkout).not.toHaveBeenCalled()
  await waitFor(() => expect(view.getByRole("button", { name: "Choose Studio" })).toBeEnabled())
  await setupUser().click(view.getByRole("button", { name: "Choose Studio" }))
  expect(state.checkout).toHaveBeenCalledWith("price_server_studio")
})

it("uses the authenticated offer price and Portal for subscription changes", async () => {
  state.session.data = { user: { id: "subscriber" } }
  state.billing.data = { ...free, plan: offers[0].plan, subscription, offers: [offers[0], { ...offers[1], priceId: "price_current_house" }] }
  const view = render(<PricingClient />)
  await setupUser().click(await view.findByRole("button", { name: "Choose House" }))
  expect(state.portal).toHaveBeenCalledWith("price_current_house")
  expect(state.checkout).not.toHaveBeenCalled()
  expect(view.getByRole("button", { name: "Current plan" })).toBeDisabled()
  await setupUser().click(view.getByRole("button", { name: "Manage cancellation" }))
  expect(state.portal).toHaveBeenLastCalledWith()
})

it.each(["Studio", "House"])("requires explicit Founder confirmation for %s", async (name) => {
  state.session.data = { user: { id: "founder" } }
  state.billing.data = { ...free, plan: offers[1].plan, isFounder: true }
  const view = render(<PricingClient />)
  const user = setupUser()
  await waitFor(() => expect(view.getByRole("button", { name: `Choose ${name}` })).toBeEnabled())
  await user.click(view.getByRole("button", { name: `Choose ${name}` }))
  expect(await view.findByRole("dialog")).toHaveTextContent("permanently ends your Founder access")
  expect(state.checkout).not.toHaveBeenCalled()
  await user.click(view.getByRole("button", { name: "Keep Founder" }))
  await waitFor(() => expect(view.queryByRole("dialog")).not.toBeInTheDocument())
  expect(state.checkout).not.toHaveBeenCalled()
  await user.click(view.getByRole("button", { name: `Choose ${name}` }))
  await user.click(view.getByRole("button", { name: "Continue to checkout" }))
  expect(state.checkout).toHaveBeenCalledTimes(1)
  expect(state.checkout).toHaveBeenCalledWith(offers.find((offer) => offer.plan.displayName === name)!.priceId, true)
  expect(state.portal).not.toHaveBeenCalled()
})

it("disables scheduled changes", async () => {
  state.session.data = { user: { id: "subscriber" } }
  state.billing.data = { ...free, plan: offers[1].plan, subscription: { ...subscription, plan: offers[1].plan, scheduledChange: { plan: offers[0].plan, effectiveAt: "2027-01-01T00:00:00Z" } } }
  const view = render(<PricingClient />)
  expect(await view.findByRole("button", { name: "Scheduled" })).toBeDisabled()
})

it("fails closed on a catalog error and supports retry", async () => {
  state.api.mockRejectedValueOnce(new Error("offline"))
  const view = render(<PricingClient />)
  expect(await view.findByRole("alert")).toHaveTextContent("Couldn't load plans")
  expect(view.getByTestId("pricing-choose-studio")).toBeDisabled()
  await setupUser().click(view.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(view.getByRole("button", { name: "Choose Studio" })).toBeEnabled())
})

it("does not invent purchasable offers when the catalog is empty", async () => {
  state.api.mockResolvedValue({ ...catalog, offers: [] })
  state.search = new URLSearchParams({ plan: "unknown" })
  const view = render(<PricingClient />)
  await waitFor(() => expect(view.getByRole("button", { name: "Start free" })).toBeEnabled())
  expect(view.getAllByRole("button", { name: "Unavailable" })).toHaveLength(2)
  expect(view.queryByText(/selected/)).not.toBeInTheDocument()
})

it("does not allow stale public prices to initiate purchase when account loading failed", async () => {
  state.session.data = { user: { id: "buyer" } }
  state.billing = { ...state.billing, isError: true }
  const view = render(<PricingClient />)
  await view.findByRole("alert")
  expect(view.getByTestId("pricing-choose-studio")).toBeDisabled()
  expect(state.checkout).not.toHaveBeenCalled()
})


it("shows machine allowances supplied by the catalog", async () => {
  state.api.mockResolvedValue({ ...catalog, offers: [{ ...offers[0], machineLimit: 7 }, offers[1]] })
  const ui = render(<PricingClient />)
  expect(await ui.findByText((_text, el) => el?.tagName === "P" && el.textContent === "Up to 7 online machines")).toBeInTheDocument()
  expect(ui.getByText((_text, el) => el?.tagName === "P" && el.textContent === "Up to 1 online machine")).toBeInTheDocument()
})
