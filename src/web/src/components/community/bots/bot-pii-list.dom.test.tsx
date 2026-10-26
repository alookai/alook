import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { BotPiiList } from "./bot-pii-list"

const plugins = [
  { id: "secrets", name: "Secrets", description: "Masks access tokens", enabled: true },
  { id: "email", name: "Email addresses", description: "Masks email addresses", enabled: false },
]
const props = () => ({ botName: "Alli", plugins, pending: false, onSetEnabled: vi.fn(), onDelete: vi.fn().mockResolvedValue(true) })

describe("PII plugin controls", () => {
  it("preserves pipeline order and waits for confirmed state after toggling", () => {
    const input = props()
    render(<BotPiiList {...input} />)
    expect(screen.getAllByRole("listitem").map(row => row.getAttribute("data-testid"))).toEqual(["pii-plugin-secrets", "pii-plugin-email"])
    fireEvent.click(screen.getByRole("switch", { name: "Secrets filter" }))
    expect(input.onSetEnabled).toHaveBeenCalledWith("secrets", false)
    expect(screen.getByRole("switch", { name: "Secrets filter" })).toBeChecked()
  })

  it.each([{ pending: true }, { unavailable: "Machine is offline. Reconnect to manage filters." }])("blocks writes when unavailable: %j", overrides => {
    const input = { ...props(), ...overrides }
    render(<BotPiiList {...input} />)
    expect(screen.getByRole("switch", { name: "Secrets filter" })).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(screen.getByRole("switch", { name: "Secrets filter" }))
    expect(screen.getByRole("button", { name: "Actions for Secrets" })).toBeDisabled()
    expect(input.onSetEnabled).not.toHaveBeenCalled()
  })

  it("requires explicit delete confirmation and keeps failures open", async () => {
    const input = props()
    input.onDelete.mockResolvedValue(false)
    const view = render(<BotPiiList {...input} />)
    fireEvent.click(screen.getByRole("button", { name: "Actions for Secrets" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    expect(input.onDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(input.onDelete).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Actions for Secrets" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete filter" }))
    await waitFor(() => expect(input.onDelete).toHaveBeenCalledWith("secrets"))
    view.rerender(<BotPiiList {...input} error="Could not confirm the change. Reload filters." />)
    expect(screen.getByRole("alertdialog")).toBeVisible()
    input.onDelete.mockResolvedValue(true)
    fireEvent.click(screen.getByRole("button", { name: "Delete filter" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })
})
