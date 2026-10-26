import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
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
  animate.mockImplementation(() => ({ cancel: vi.fn() }))
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

  it("restarts one finite shake for every unchecked attempt and stops it on agreement or unmount", async () => {
    const result = render(createElement(SignIn))
    const user = setupUser()
    await user.click(screen.getByRole("button", { name: "Email" }))
    const first = animate.mock.results[0].value
    await user.click(screen.getByRole("button", { name: "Google" }))
    const second = animate.mock.results[1].value
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(second.cancel).not.toHaveBeenCalled()
    expect(animate).toHaveBeenCalledTimes(2)
    for (const [frames, options] of animate.mock.calls) {
      expect(frames[0]).toEqual({ transform: "translateX(0)" })
      expect(frames.at(-1)).toEqual({ transform: "translateX(0)" })
      expect(options).toEqual({ duration: 280, easing: "ease-in-out" })
    }
    expect(agreement()).toHaveFocus()
    expect(continued).not.toHaveBeenCalled()
    await user.click(agreement())
    expect(second.cancel).toHaveBeenCalledOnce()
    await user.click(agreement())
    await user.click(screen.getByRole("button", { name: "Email" }))
    const third = animate.mock.results[2].value
    result.unmount()
    expect(third.cancel).toHaveBeenCalledOnce()
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
    expect(checkbox).toHaveAttribute("aria-invalid", "true")
    expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
    expect(continued).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("sign-in-terms-cancel"))
    expect(agreement()).not.toBeChecked()
    expect(screen.getByRole("button", { name: "Email" })).toHaveFocus()
    expect(screen.getByRole("alert")).toHaveClass("text-destructive")
    expect(continued).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Google" }))
    expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
    const confirm = screen.getByTestId("sign-in-terms-confirm")
    expect(confirm).toHaveTextContent(/^Agree$/)
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
    expect(screen.getByRole("button", { name: "Email" })).toHaveFocus()
    expect(continued).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Google" }))
    const confirm = screen.getByTestId("sign-in-terms-confirm")
    result.unmount()
    await act(async () => confirm.click())
    expect(continued).not.toHaveBeenCalled()
  })

  it.each(["replace", "uncheck", "unmount"])("handles %s while the confirmed dialog is still closing", async action => {
    width = 375
    const result = render(createElement(SignIn))
    const user = setupUser()
    const checkbox = agreement()
    await user.click(screen.getByRole("button", { name: "Google" }))
    const popup = screen.getByRole("dialog")
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const getAnimations = vi.fn(() => [{ finished }])
    Object.defineProperty(popup, "getAnimations", { value: getAnimations })
    await user.click(screen.getByRole("button", { name: "Agree" }))
    await waitFor(() => expect(getAnimations).toHaveBeenCalled())
    expect(continued).not.toHaveBeenCalled()
    if (action === "replace") {
      await user.click(screen.getByRole("button", { name: "Email" }))
      expect(continued).not.toHaveBeenCalled()
    } else if (action === "uncheck") {
      await user.click(checkbox)
    } else result.unmount()
    await act(async () => { finish(); await finished })
    if (action === "replace") {
      await waitFor(() => expect(continued).toHaveBeenCalledExactlyOnceWith("email"))
    } else {
      if (action === "uncheck") await user.click(checkbox)
      expect(continued).not.toHaveBeenCalled()
    }
  })

  it.each([375, 639, 640, 1280])("at %spx rechecks current agreement when switching methods after unchecking", async value => {
    width = value
    render(createElement(SignIn))
    const user = setupUser()
    await user.click(agreement())
    expect(screen.queryByRole("alert")).toBeNull()
    expect(document.getElementById("sign-in-terms-copy")).not.toHaveClass("text-destructive")
    await user.click(screen.getByRole("button", { name: "Email" }))
    expect(continued).toHaveBeenCalledExactlyOnceWith("email")
    await user.click(agreement())
    await user.click(screen.getByRole("button", { name: "Google" }))
    expect(continued).toHaveBeenCalledOnce()
    const checkbox = document.getElementById("sign-in-terms-checkbox")
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toHaveAttribute("aria-invalid", "true")
    expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
    if (value < 640) {
      expect(screen.getByRole("dialog")).toBeVisible()
      await user.click(screen.getByTestId("sign-in-terms-cancel"))
      await user.click(screen.getByRole("button", { name: "Email" }))
      expect(document.getElementById("sign-in-terms-copy")).toHaveClass("text-destructive")
      await user.click(screen.getByRole("button", { name: "Agree" }))
      expect(continued.mock.calls).toEqual([["email"], ["email"]])
      expect(agreement()).toBeChecked()
      expect(screen.queryByRole("alert")).toBeNull()
      expect(animate).not.toHaveBeenCalled()
    } else {
      expect(screen.getByRole("alert")).toBeVisible()
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(checkbox).toHaveFocus()
      expect(animate).toHaveBeenCalledOnce()
    }
  })
})
