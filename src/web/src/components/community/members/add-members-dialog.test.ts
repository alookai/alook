import { describe, it, expect, vi, beforeEach } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// Spy on toastApiError so the reject path can be asserted without a real DOM
// (sonner injects a <style> at import time). Mock before importing the module.
const toastApiErrorSpy = vi.fn()
vi.mock("@/lib/api/client", () => ({
  toastApiError: (...args: unknown[]) => toastApiErrorSpy(...args),
}))

import { AddMemberRow, runAdd, type AddableCandidate } from "./add-members-dialog"

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
})

describe("runAdd", () => {
  beforeEach(() => {
    toastApiErrorSpy.mockClear()
  })

  // Capture the sequence of set-state updater results so we can assert the id
  // enters then leaves the in-flight set.
  function trackingSetter() {
    let set = new Set<string>()
    const calls: string[][] = []
    const setAddingIds = (updater: Set<string> | ((s: Set<string>) => Set<string>)) => {
      set = typeof updater === "function" ? updater(set) : updater
      calls.push([...set])
    }
    return { setAddingIds: setAddingIds as never, snapshots: () => calls, current: () => [...set] }
  }

  it("marks the id in flight and KEEPS it on success (spinner persists until the row unmounts)", async () => {
    const t = trackingSetter()
    await runAdd("u_1", async () => {}, t.setAddingIds)
    // Added once, never cleared — the row leaves the candidate list on refetch,
    // so clearing here would flash the button back to "Add" for a frame.
    expect(t.snapshots()).toEqual([["u_1"]])
    expect(t.current()).toEqual(["u_1"])
    expect(toastApiErrorSpy).not.toHaveBeenCalled()
  })

  it("clears the id AND toasts on failure (row reverts to a clickable Add)", async () => {
    const t = trackingSetter()
    await runAdd("u_1", async () => { throw new Error("nope") }, t.setAddingIds)
    expect(t.current()).toEqual([])
    expect(toastApiErrorSpy).toHaveBeenCalledTimes(1)
    expect(toastApiErrorSpy).toHaveBeenCalledWith(expect.any(Error), "Couldn't add member")
  })
})
