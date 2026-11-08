import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { JSDOM } from "jsdom"

vi.mock("@/lib/api/client", () => ({ toastApiError: vi.fn() }))
import { AddMemberRow, type AddableCandidate } from "./add-members-dialog"

const candidate: AddableCandidate = { userId: "u_1", name: "Alice", avatar: "A" }
function withRow(adding: boolean, check: (document: Document) => void) {
  const dom = new JSDOM(renderToStaticMarkup(createElement(AddMemberRow, { candidate, adding, onAdd: () => {} })))
  try { check(dom.window.document) } finally { dom.window.close() }
}

describe("AddMemberRow server output", () => {
  it("disables the action and removes its idle label while adding", () => {
    withRow(true, document => {
      const button = document.querySelector<HTMLButtonElement>("button")!
      expect(button.disabled).toBe(true)
      expect(button.textContent).toBe("")
    })
  })
  it("offers the enabled Add action while idle", () => {
    withRow(false, document => {
      const button = document.querySelector<HTMLButtonElement>("button")!
      expect(button.disabled).toBe(false)
      expect(button.textContent).toBe("Add")
    })
  })
  it("renders the candidate display name", () => {
    withRow(false, document => { expect(document.body.textContent).toContain("Alice") })
  })
})
