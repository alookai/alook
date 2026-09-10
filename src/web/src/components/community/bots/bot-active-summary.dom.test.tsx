import { describe, expect, it, vi } from "vitest"
import { render, setupUser } from "@/test/react-dom-harness"
import { BotActiveSummary } from "./bot-active-summary"

const summary = {
  isFounder: false,
  plan: { id: "free", displayName: "Free" },
  activeCount: 2,
  ownedCount: 3,
  limit: 3,
}

describe("BotActiveSummary", () => {
  it("discloses counts and plan on click and keeps the default row compact", async () => {
    const view = render(<BotActiveSummary summary={summary} />)
    expect(view.queryByRole("progressbar")).not.toBeInTheDocument()
    await setupUser().click(view.getByRole("button", { name: "Active Bots: 2 of 3 allowed, 3 owned, Free plan" }))
    expect(view.getByLabelText("2 of 3 active bot slots used")).toBeInTheDocument()
    expect(view.getByText("Free")).toBeInTheDocument()
  })

  it("reveals the details on desktop hover", async () => {
    const view = render(<BotActiveSummary summary={summary} />)
    await setupUser().hover(view.getByRole("button", { name: "Active Bots: 2 of 3 allowed, 3 owned, Free plan" }))
    expect(await view.findByLabelText("2 of 3 active bot slots used")).toBeInTheDocument()
    expect(view.getByText("Free")).toBeInTheDocument()
  })

  it("separates active allowance from retained bots after downgrade", async () => {
    const view = render(<BotActiveSummary summary={{ ...summary, activeCount: 3, ownedCount: 40 }} />)
    await setupUser().click(view.getByRole("button", { name: "Active Bots: 3 of 3 allowed, 40 owned, Free plan" }))
    expect(view.getByLabelText("3 of 3 active bot slots used")).toBeInTheDocument()
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "100 100")
    expect(view.getByText("40 bots owned")).toBeInTheDocument()
    expect(view.queryByText("3 / 40 active")).not.toBeInTheDocument()
  })

  it("offers View plan from the usage popup", async () => {
    const viewPlan = vi.fn()
    const view = render(<BotActiveSummary summary={summary} onViewPlan={viewPlan} />)
    const user = setupUser()
    await user.click(view.getByRole("button", { name: /Active Bots:/ }))
    await user.click(view.getByRole("button", { name: "View plan" }))
    expect(viewPlan).toHaveBeenCalledOnce()
    expect(view.queryByRole("button", { name: "View plan" })).not.toBeInTheDocument()
  })

  it("uses plan capacity rather than owned total and handles zero bots", () => {
    const view = render(<BotActiveSummary summary={{ ...summary, activeCount: 1, ownedCount: 2 }} />)
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "33.33333333333333 100")
    view.rerender(<BotActiveSummary summary={{ ...summary, activeCount: 0, ownedCount: 0 }} />)
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "0 100")
    expect(view.getByRole("button", { name: "Active Bots: 0 of 3 allowed, 0 owned, Free plan" })).toBeEnabled()
  })
})
