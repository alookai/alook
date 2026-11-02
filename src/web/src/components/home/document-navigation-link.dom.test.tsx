import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { DocumentNavigationLink } from "./document-navigation-link"

function mount() {
  return render(<div onClick={event => event.preventDefault()}>
    <DocumentNavigationLink href="/sign-in">Get started</DocumentNavigationLink>
    <DocumentNavigationLink href="/sign-in">Sign in</DocumentNavigationLink>
  </div>)
}

describe("document navigation feedback", () => {
  it("marks only the clicked entrance while preserving the native link and its content", () => {
    mount()
    const [clicked, untouched] = screen.getAllByRole("link")
    fireEvent.click(clicked)
    expect(clicked).toHaveAttribute("aria-busy", "true")
    expect(untouched).not.toHaveAttribute("aria-busy")
    expect(clicked).toHaveAttribute("href", "/sign-in")
    expect(screen.getByRole("status")).toHaveTextContent("Opening…")
    expect(screen.getByText("Get started")).toHaveStyle({ visibility: "hidden" })
    expect(clicked).not.toHaveAttribute("aria-disabled")
    fireEvent.click(clicked)
    expect(clicked).toHaveAttribute("aria-busy", "true")
  })

  it.each(["pageshow", "Escape"])("restores feedback after %s and allows another attempt", event => {
    mount()
    const clicked = screen.getAllByRole("link")[0]
    fireEvent.click(clicked)
    act(() => { window.dispatchEvent(event === "Escape" ? new KeyboardEvent("keydown", { key: "Escape" }) : new Event("pageshow")) })
    expect(clicked).not.toHaveAttribute("aria-busy")
    expect(screen.queryByRole("status")).toBeNull()
    fireEvent.click(clicked)
    expect(clicked).toHaveAttribute("aria-busy", "true")
  })

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])("does not mark modified click %j", modifiers => {
    mount()
    const clicked = screen.getAllByRole("link")[0]
    fireEvent.click(clicked, modifiers)
    expect(clicked).not.toHaveAttribute("aria-busy")
  })

  it.each([{ target: "_blank" }, { download: "file" }, { onClick: (event: React.MouseEvent) => event.preventDefault() }])("does not mark a different browsing context or cancelled click", props => {
    render(<div onClick={event => event.preventDefault()}><DocumentNavigationLink href="/sign-in" {...props}>Continue</DocumentNavigationLink></div>)
    fireEvent.click(screen.getByRole("link"))
    expect(screen.getByRole("link")).not.toHaveAttribute("aria-busy")
  })

  it("does not prevent default document navigation and preserves the caller callback", () => {
    const callback = vi.fn()
    render(<DocumentNavigationLink href="/sign-in" onClick={callback}>Continue</DocumentNavigationLink>)
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    act(() => { screen.getByRole("link").dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(callback).toHaveBeenCalledOnce()
  })
})
