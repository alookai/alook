import { describe, expect, it } from "vitest"
import { render } from "@/test/react-dom-harness"
import { MachineCard } from "./machine-card"
import type { MachineSummary } from "@/hooks/community/use-machines"

const stable: MachineSummary = { id: "machine", hostname: "host", displayName: "Computer", platform: "darwin", arch: "arm64", osRelease: "24", daemonVersion: "1", createdAt: "created", updatedAt: "updated" }
describe("restored machine observations", () => {
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
