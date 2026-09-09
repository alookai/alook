import { describe, expect, it } from "vitest"
import { render, setupUser } from "@/test/react-dom-harness"
import { BotActiveSummary } from "./bot-active-summary"

const summary = {
  plan: { id: "free", displayName: "Free" },
  activeCount: 2,
  ownedCount: 3,
  limit: 3,
}

describe("BotActiveSummary", () => {
  it("discloses counts and plan on click and keeps the default row compact", async () => {
    const view = render(<BotActiveSummary summary={summary} />)
    expect(view.queryByText("2 / 3 active")).not.toBeInTheDocument()
    await setupUser().click(view.getByRole("button", { name: "Active Bots: 2 of 3, Free plan" }))
    expect(view.getByText("2 / 3 active")).toBeInTheDocument()
    expect(view.getByText("Free")).toBeInTheDocument()
  })

  it("reveals the details on desktop hover", async () => {
    const view = render(<BotActiveSummary summary={summary} />)
    await setupUser().hover(view.getByRole("button", { name: "Active Bots: 2 of 3, Free plan" }))
    expect(await view.findByText("2 / 3 active")).toBeInTheDocument()
    expect(view.getByText("Free")).toBeInTheDocument()
  })

  it("uses owned total rather than plan capacity and handles zero bots", () => {
    const view = render(<BotActiveSummary summary={{ ...summary, activeCount: 1, ownedCount: 2 }} />)
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "50 100")
    view.rerender(<BotActiveSummary summary={{ ...summary, activeCount: 0, ownedCount: 0 }} />)
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "0 100")
    expect(view.getByRole("button", { name: "Active Bots: 0 of 0, Free plan" })).toBeEnabled()
  })
})
