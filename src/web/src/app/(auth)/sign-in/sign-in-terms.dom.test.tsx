import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, setupUser } from "@/test/react-dom-harness"
import { useSignInTerms } from "./sign-in-terms"

let width = 640
let reducedMotion = false
const continued = vi.fn()
const animate = vi.fn()

function SignIn() {
  const terms = useSignInTerms()
  return <>{terms.control}
    <button onClick={() => terms.requestConsent(() => continued("email"))}>Email</button>
    <button onClick={() => terms.requestConsent(() => continued("google"))}>Google</button>
  </>
}

beforeEach(() => {
  vi.clearAllMocks()
  width = 640
  reducedMotion = false
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("max-width") ? width < 640 : query.includes("reduced-motion") && reducedMotion,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as never
  HTMLElement.prototype.animate = animate
})

const agreement = () => screen.getByRole("checkbox", { name: "I agree to the Terms of Service" })

describe("sign-in agreement", () => {
  it("starts unchecked and keeps policy links separate from agreement", async () => {
    render(createElement(SignIn))
    expect(agreement()).not.toBeChecked()
    for (const [name, href] of [["Terms of Service", "/terms"], ["Privacy Policy", "/privacy"]]) {
      const link = screen.getByRole("link", { name })
      expect(link).toHaveAttribute("href", href)
      expect(link).toHaveAttribute("target", "_blank")
      await setupUser().click(link)
      expect(agreement()).not.toBeChecked()
    }
    expect(continued).not.toHaveBeenCalled()
  })

  it.each([640, 1280])("at %spx focuses and shakes without starting login or opening a dialog", async value => {
    width = value
    render(createElement(SignIn))
    await setupUser().click(screen.getByRole("button", { name: "Google" }))
    expect(agreement()).toHaveFocus()
    expect(agreement()).not.toBeChecked()
    expect(screen.getByRole("alert")).toHaveTextContent("I agree to the Terms of Service")
    expect(screen.getByRole("alert")).toHaveClass("text-destructive")
    expect(screen.queryByText("Please agree to the Terms of Service to continue.")).toBeNull()
    expect(animate).toHaveBeenCalledOnce()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(continued).not.toHaveBeenCalled()
  })

  it("keeps the desktop reminder and focus without motion when reduced motion is enabled", async () => {
    reducedMotion = true
    render(createElement(SignIn))
    await setupUser().click(screen.getByRole("button", { name: "Email" }))
    expect(agreement()).toHaveFocus()
    expect(screen.getByRole("alert")).toHaveTextContent("I agree to the Terms of Service")
    expect(screen.getByRole("alert")).toHaveClass("text-destructive")
    expect(animate).not.toHaveBeenCalled()
    expect(continued).not.toHaveBeenCalled()
  })

  it.each([375, 639])("at %spx cancels without accepting and confirms the selected method only once", async value => {
    width = value
    render(createElement(SignIn))
    const checkbox = agreement()
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Email" }))
    expect(screen.getByRole("dialog")).toHaveTextContent("Agree to continue")
    expect(checkbox).not.toBeChecked()
    expect(continued).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("sign-in-terms-cancel"))
    expect(agreement()).not.toBeChecked()
    expect(continued).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Google" }))
    const confirm = screen.getByTestId("sign-in-terms-confirm")
    await user.click(confirm)
    await act(async () => confirm.click())
    expect(agreement()).toBeChecked()
    expect(continued).toHaveBeenCalledExactlyOnceWith("google")
    expect(animate).not.toHaveBeenCalled()
  })

  it("discards a pending mobile action when dismissed or unmounted", async () => {
    width = 375
    const result = render(createElement(SignIn))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Email" }))
    await user.keyboard("{Escape}")
    expect(agreement()).not.toBeChecked()
    expect(continued).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Google" }))
    const confirm = screen.getByTestId("sign-in-terms-confirm")
    result.unmount()
    await act(async () => confirm.click())
    expect(continued).not.toHaveBeenCalled()
  })

  it("continues checked actions directly and returns to admission when unchecked", async () => {
    render(createElement(SignIn))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Email" }))
    expect(screen.getByRole("alert")).toHaveClass("text-destructive")
    expect(continued).not.toHaveBeenCalled()
    await user.click(agreement())
    expect(screen.queryByRole("alert")).toBeNull()
    expect(document.getElementById("sign-in-terms-copy")).not.toHaveClass("text-destructive")
    await user.click(screen.getByRole("button", { name: "Email" }))
    expect(continued).toHaveBeenCalledExactlyOnceWith("email")
    await user.click(agreement())
    await user.click(screen.getByRole("button", { name: "Google" }))
    expect(continued).toHaveBeenCalledOnce()
    expect(agreement()).not.toBeChecked()
    expect(screen.getByRole("alert")).toBeVisible()
  })
})
