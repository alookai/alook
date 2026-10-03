import React, { useLayoutEffect } from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { ApplicationOwnerProvider, createApplicationOwner, retireApplicationOwner, type ApplicationOwner } from "@/lib/application-owner"
import { useApplicationViewSource } from "./use-application-view-source"

let owner: ApplicationOwner
let source: ReturnType<typeof useApplicationViewSource>
const captures: Array<ReturnType<ReturnType<typeof useApplicationViewSource>["capture"]>> = []
function Probe({ identity }: { identity: string }) {
  const current = useApplicationViewSource(identity)
  useLayoutEffect(() => { source = current; captures.push(current.capture()) }, [current])
  return null
}
function App({ identity = "A" }: { identity?: string }) {
  return <ApplicationOwnerProvider owner={owner}><Probe identity={identity} /></ApplicationOwnerProvider>
}
beforeEach(() => {
  owner = createApplicationOwner("view-user", new QueryClient())
  captures.length = 0
  return () => { retireApplicationOwner(owner); owner.queryClient.clear() }
})

describe("actual application view intent", () => {
  it("keeps the current identity stable and retires the original signal across A to B to A", () => {
    const view = render(<App />)
    const first = source
    const original = source.capture()
    view.rerender(<App />)
    expect(source).toBe(first)
    expect(() => original.assert()).not.toThrow()
    act(() => view.rerender(<App identity="B" />))
    expect(original.signal.aborted).toBe(true)
    expect(() => original.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
    const middle = source.capture()
    act(() => view.rerender(<App />))
    expect(middle.signal.aborted).toBe(true)
    expect(() => middle.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(source.capture().signal.aborted).toBe(false)
    expect(() => source.capture().assert()).not.toThrow()
    expect(() => original.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
  })

  it("Strict replay replaces its aborted controller and leaves only the current capture usable", () => {
    const view = render(<React.StrictMode><App /></React.StrictMode>)
    expect(captures.length).toBeGreaterThanOrEqual(2)
    const first = captures[0]!
    const current = source.capture()
    expect(first.signal.aborted).toBe(true)
    expect(() => first.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(current.signal.aborted).toBe(false)
    expect(() => current.assert()).not.toThrow()
    view.unmount()
    expect(current.signal.aborted).toBe(true)
    expect(() => current.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
  })

  it("explicit view retirement blocks old continuations while the account stays active", () => {
    render(<App />)
    const original = source.capture()
    act(() => source.retire())
    expect(original.signal.aborted).toBe(true)
    expect(() => original.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(owner.lifecycle.get().active).toBe(true)
  })

  it("account retirement invalidates an original continuation even before view unmount", () => {
    render(<App />)
    const original = source.capture()
    act(() => retireApplicationOwner(owner))
    expect(() => original.assert()).toThrow(expect.objectContaining({ name: "AbortError" }))
  })
})
