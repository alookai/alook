import { describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { MachineRuntimes } from "./machine-runtimes"

describe("MachineRuntimes unavailable disclosure", () => {
  it("collapses unhealthy runtimes by default when healthy ones exist and toggles on click", () => {
    render(
      <MachineRuntimes
        runtimes={[
          { id: "claude", status: "healthy" },
          { id: "codex-cli", status: "unhealthy", lastError: "spawn_enoent" },
          { id: "pi", status: "unhealthy" },
        ]}
      />,
    )

    expect(screen.getByText("Claude")).toBeInTheDocument()
    expect(screen.queryByText("Codex CLI")).not.toBeInTheDocument()
    expect(screen.queryByText("Pi")).not.toBeInTheDocument()

    const toggle = screen.getByRole("button", { name: "+2 unavailable" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(toggle)
    expect(screen.getByText("Codex CLI")).toBeInTheDocument()
    expect(screen.getByText("Pi")).toBeInTheDocument()
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("Hide unavailable")

    fireEvent.click(toggle)
    expect(screen.queryByText("Codex CLI")).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("+2 unavailable")
  })

  it("renders unhealthy runtimes directly without a toggle when no healthy runtimes exist", () => {
    render(
      <MachineRuntimes
        runtimes={[
          { id: "codex-cli", status: "unhealthy" },
          { id: "pi", status: "unhealthy" },
        ]}
      />,
    )

    expect(screen.getByText("Codex CLI")).toBeInTheDocument()
    expect(screen.getByText("Pi")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^\+\d+ unavailable$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Hide unavailable" })).not.toBeInTheDocument()
  })
})
