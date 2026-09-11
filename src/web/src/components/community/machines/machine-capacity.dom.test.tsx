import { describe, expect, it, vi } from "vitest"
import { render, setupUser } from "@/test/react-dom-harness"
import { MachineCapacityUsage, MachineLimitDialog } from "./machine-capacity"

const summary = { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 5, onlineCount: 1 }

describe("Machine capacity", () => {
  it("separates online use from retained owned machines and opens billing", async () => {
    const viewPlan = vi.fn()
    const view = render(<MachineCapacityUsage summary={summary} onViewPlan={viewPlan} />)
    const user = setupUser()
    await user.click(view.getByRole("button", { name: "Online machines: 1 of 1 allowed, 5 owned, Free plan" }))
    expect(view.getByText("5 machines owned")).toBeInTheDocument()
    expect(view.getByLabelText("1 of 1 online machine slots used")).toBeInTheDocument()
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "100 100")
    await user.click(view.getByRole("button", { name: "View plan" }))
    expect(viewPlan).toHaveBeenCalledOnce()
  })
  it("shows Founder allowance and safe zero/loading states", () => {
    const view = render(<MachineCapacityUsage summary={{ ...summary, isFounder: true, limit: 10, onlineCount: 0 }} onViewPlan={vi.fn()} />)
    expect(view.getByRole("button", { name: /Founder plan/ })).toBeEnabled()
    expect(view.container.querySelector('[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "0 100")
    view.rerender(<MachineCapacityUsage summary={null} onViewPlan={vi.fn()} />)
    expect(view.getByRole("button", { name: "Machine usage loading" })).toBeDisabled()
  })
  it("explains that offline machines count and closes before opening the plan", async () => {
    const close = vi.fn(), viewPlan = vi.fn()
    const view = render(<MachineLimitDialog open onOpenChange={close} onViewPlan={viewPlan} limit={1} />)
    expect(view.getByText(/Offline machines also count/)).toBeInTheDocument()
    await setupUser().click(view.getByRole("button", { name: "View plan" }))
    expect(close).toHaveBeenCalledWith(false)
    expect(viewPlan).toHaveBeenCalledOnce()
  })
  it("explains online capacity for a reconnect instead of asking to delete records", () => {
    const view = render(<MachineLimitDialog open reconnect onOpenChange={vi.fn()} onViewPlan={vi.fn()} limit={1} />)
    expect(view.getByText(/All online slots are in use/)).toBeInTheDocument()
    expect(view.queryByText(/Offline machines also count/)).not.toBeInTheDocument()
  })
  it("dismisses without navigating", async () => {
    const close = vi.fn(), viewPlan = vi.fn()
    const view = render(<MachineLimitDialog open onOpenChange={close} onViewPlan={viewPlan} limit={5} />)
    await setupUser().click(view.getByRole("button", { name: "Got it" }))
    expect(close).toHaveBeenCalledWith(false)
    expect(viewPlan).not.toHaveBeenCalled()
  })
})
