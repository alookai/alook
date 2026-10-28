import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"

vi.mock("@/lib/auth-client", () => ({
  useSession: () => { throw new Error("Tutorial must not mount the auth owner") },
  currentSessionViewer: () => { throw new Error("Tutorial must not read an auth session") },
  authClient: new Proxy({}, { get: () => { throw new Error("Tutorial must not call the auth client") } }),
}))
vi.mock("@/lib/product-analytics", () => ({ captureProductAnalytics: () => { throw new Error("Tutorial must not emit auth analytics") } }))

import { SignInPreview } from "./sign-in-preview"

afterEach(() => vi.unstubAllGlobals())

describe("native sign-in tutorial preview", () => {
  it("reuses the complete sign-in view without autofocus, auth calls or fetches", () => {
    const fetch = vi.fn(() => { throw new Error("Preview must not fetch") })
    vi.stubGlobal("fetch", fetch)
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
    const outside = document.createElement("button")
    document.body.append(outside)
    outside.focus()
    const view = render(<SignInPreview />)
    try {
      expect(view.container.querySelector("[inert][aria-hidden=true]")).not.toBeNull()
      expect(view.container.querySelector("h1")).toBeNull()
      expect(document.activeElement).toBe(outside)
      expect(view.container.querySelector('input[type="email"]')?.getAttribute("placeholder")).toBe("you@example.com")
      expect(view.container.querySelector('[alt="Alook"]')).not.toBeNull()
      expect(view.container.textContent).toContain("Send Code")
      expect(view.container.textContent).toContain("Terms of Service")
      expect(view.container.textContent).toContain("Privacy Policy")
      expect(view.container.textContent).toContain("GitHub")
      expect(view.container.textContent).toContain("Google")
      expect(view.container.textContent).toContain("Continue with Apple")
      expect(view.container.textContent).toContain("The best room for agents and humans")
      expect(view.container.querySelector('[aria-label="Product stories"]')).not.toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      outside.remove()
    }
  })
})
