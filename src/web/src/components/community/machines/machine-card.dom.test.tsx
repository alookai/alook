import { describe, expect, it, vi } from "vitest"
import { render, fireEvent } from "@/test/react-dom-harness"
import { MachineCard } from "./machine-card"
import type { MachineSummary } from "@/hooks/community/use-machines"

const stable: MachineSummary = { id: "machine", hostname: "host", displayName: "Computer", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "1", createdAt: "created", updatedAt: "updated" }
describe("restored machine observations", () => {
  it("shows Stop only online and disables it during dispatch", async () => {
    const onStop = vi.fn()
    const view = render(<MachineCard machine={{ ...stable, status: "online" }} onDelete={() => {}} onReconnect={() => {}} onStop={onStop} />)
    fireEvent.click(view.getByRole("button", { name: "Machine actions" }))
    fireEvent.click(await view.findByRole("menuitem", { name: "Stop" }))
    expect(onStop).toHaveBeenCalledOnce()
    view.rerender(<MachineCard machine={{ ...stable, status: "online" }} onDelete={() => {}} onReconnect={() => {}} onStop={onStop} stopping />)
    fireEvent.click(view.getByRole("button", { name: "Machine actions" }))
    expect(await view.findByRole("menuitem", { name: "Sending stop…" })).toHaveAttribute("aria-disabled", "true")
    view.unmount()
  })

  it.each(["offline", undefined] as const)("omits Stop when status is %s", async status => {
    const view = render(<MachineCard machine={{ ...stable, status }} onDelete={() => {}} onReconnect={() => {}} onStop={() => {}} />)
    fireEvent.click(view.getByRole("button", { name: "Machine actions" }))
    await view.findByRole("menuitem", { name: "Reconnect…" })
    expect(view.queryByRole("menuitem", { name: "Stop" })).toBeNull()
  })

  it("shows the stable card and unknown observations until live data arrives", () => {
    const view = render(<MachineCard machine={stable} onDelete={() => {}} onReconnect={() => {}} />)
    expect(view.getByText("Computer")).toBeInTheDocument()
    expect(view.getByText("Status unknown")).toBeInTheDocument()
    expect(view.getByText("Last seen unknown")).toBeInTheDocument()
    expect(view.queryByText("Offline")).toBeNull()
    expect(view.queryByText("Never seen")).toBeNull()
    view.rerender(<MachineCard machine={{ ...stable, status: "online", lastSeenAt: null }} onDelete={() => {}} onReconnect={() => {}} />)
    expect(view.getByText("Online")).toBeInTheDocument()
    expect(view.getByText("Never seen")).toBeInTheDocument()
  })
})
