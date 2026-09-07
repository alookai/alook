import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"
import { MessageHeader, MessageHeaderMobileBack } from "./message-header"

describe("MessageHeader", () => {
  it("owns one stable left / identity / actions frame", () => {
    render(createElement(MessageHeader, {
      leading: createElement("span", { "data-zone": "leading" }),
      identity: createElement("span", null, "Identity"),
      actions: createElement("button", null, "Action"),
    }))

    const header = screen.getByRole("banner")
    expect(header).toHaveClass("h-12")
    expect(header.querySelector('[data-zone="leading"]')).not.toBeNull()
    expect(header.querySelector('[data-slot="message-header-identity"]')).toHaveTextContent("Identity")
    expect(header.querySelector('[data-slot="message-header-actions"]')).toContainElement(
      screen.getByRole("button", { name: "Action" }),
    )
  })

  it("keeps explicit parent navigation mobile-only with a 44px target", async () => {
    const onNavigate = vi.fn()
    const user = setupUser()
    render(createElement(MessageHeaderMobileBack, { onNavigate }))

    const back = screen.getByRole("button", { name: "Back" })
    expect(back).toHaveClass("size-11", "sm:hidden")
    await user.click(back)
    expect(onNavigate).toHaveBeenCalledOnce()
  })

  it("can keep the same 44px control visible inside an embedded mobile preview", () => {
    render(createElement(MessageHeaderMobileBack, {
      onNavigate: () => undefined,
      display: "always",
    }))

    const button = screen.getByRole("button", { name: "Back" })
    expect(button).toHaveClass("size-11")
    expect(button).not.toHaveClass("sm:hidden")
  })
})
