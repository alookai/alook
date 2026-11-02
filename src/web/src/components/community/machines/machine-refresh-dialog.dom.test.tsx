import { describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import type { MachineSummary } from "@/hooks/community/use-machines"
import { MachineRefreshDialog } from "./machine-refresh-dialog"

const machine = { id: "machine", hostname: "Studio Mac", displayName: "Work computer" } as MachineSummary

describe("Machine Refresh confirmation", () => {
  it("can cancel without restarting the machine", () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    const view = render(<MachineRefreshDialog machine={machine} onOpenChange={onOpenChange} onConfirm={onConfirm} />)
    expect(view.getByRole("alertdialog")).toHaveTextContent("same daemon version")
    fireEvent.click(view.getByRole("button", { name: "Cancel" }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange.mock.calls[0][0]).toBe(false)
  })

  it("confirms the selected machine after explaining the running-bot interruption", () => {
    const onConfirm = vi.fn()
    const view = render(<MachineRefreshDialog machine={machine} onOpenChange={() => {}} onConfirm={onConfirm} />)
    expect(view.getByRole("alertdialog")).toHaveTextContent("Running bots will be interrupted")
    fireEvent.click(view.getByRole("button", { name: "Refresh machine" }))
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(machine)
  })
})
