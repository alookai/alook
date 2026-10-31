import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, setupUser } from "@/test/react-dom-harness"

const externalLink = vi.hoisted(() => ({
  click: vi.fn(),
}))

vi.mock("@/components/community/messages/message-external-link", () => ({
  handleMessageExternalLinkClick: externalLink.click,
}))

import { SignInTermsNotice } from "./sign-in-terms"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("sign-in passive terms notice", () => {
  it("renders passive consent-on-continue copy without any checkbox or confirmation dialog", () => {
    render(createElement(SignInTermsNotice))

    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    const notice = screen.getByTestId("sign-in-terms")
    expect(notice).toHaveTextContent(
      "By continuing, you agree to our Terms of Service and Privacy Policy.",
    )
  })

  it("wires Terms of Service and Privacy Policy through the external link handler", async () => {
    const user = setupUser()
    render(createElement(SignInTermsNotice))

    for (const [name, path] of [
      ["Terms of Service", "/terms"],
      ["Privacy Policy", "/privacy"],
    ] as const) {
      const link = screen.getByRole("link", { name })
      expect(link).toHaveAttribute("href", path)
      expect(link).toHaveAttribute("target", "_blank")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
      link.addEventListener("click", (event) => event.preventDefault())
      await user.click(link)
      expect(externalLink.click).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.stringContaining(path),
      )
    }
    expect(externalLink.click).toHaveBeenCalledTimes(2)
  })
})
