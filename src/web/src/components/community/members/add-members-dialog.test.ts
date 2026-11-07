import rawContractInput0 from "./add-members-dialog.tsx?raw"
import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// Spy on toastApiError so the reject path can be asserted without a real DOM
// (sonner injects a <style> at import time). Mock before importing the module.
const toastApiErrorSpy = vi.fn()
vi.mock("@/lib/api/client", () => ({
  toastApiError: (...args: unknown[]) => toastApiErrorSpy(...args),
}))

import { AddMemberRow, type AddableCandidate } from "./add-members-dialog"

const candidate: AddableCandidate = { userId: "u_1", name: "Alice", avatar: "A" }

function render(adding: boolean): string {
  return renderToStaticMarkup(
    createElement(AddMemberRow, { candidate, adding, onAdd: () => {} }),
  )
}

describe("AddMemberRow", () => {
  it("shows a spinner and disables the button while adding", () => {
    const html = render(true)
    expect(html).toContain("animate-spin")
    expect(html).toContain("disabled")
    // The literal label is replaced by the spinner while in flight.
    expect(html).not.toContain(">Add<")
  })

  it("shows the Add label and no spinner when idle", () => {
    const html = render(false)
    expect(html).toContain("Add")
    expect(html).not.toContain("animate-spin")
  })

  it("renders the candidate's display name", () => {
    expect(render(false)).toContain("Alice")
  })

  it("uses the shared resolved/loading/error/retry picker contract", () => {
    const source = rawContractInput0
    expect(source).toContain("resolved: queryState.resolved")
    expect(source).toContain("loading: queryState.loading")
    expect(source).toContain("error: queryState.error")
    expect(source).toContain('errorMessage="Couldn\'t load people."')
    expect(source).toContain('emptyMessage="Everyone is already here."')
    expect(source).toContain("onRetry={() => { source.capture()(); queryState.retry?.() }}")
  })
})
