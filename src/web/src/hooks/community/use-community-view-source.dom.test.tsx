import React, { useEffect } from "react"
import { expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { useCommunityViewSource } from "./use-community-view-source"

it("resumes a mounted effect after confirmation and retires its eligible signal on account loss", async () => {
  const owner = await createCommunityQueryOwner()
  owner.registry.bindAuthentication(() => undefined, async () => {})
  const accepted = vi.fn()
  const cleanup = vi.fn()
  const hook = renderHook(() => {
    const source = useCommunityViewSource("restored-effect")
    useEffect(() => {
      const assert = source.tryCapture()
      if (!assert) return
      accepted(assert)
      return cleanup
    }, [source])
    return source
  }, { wrapper: ({ children }: React.PropsWithChildren) => <CommunityTestProvider client={owner.client} registry={owner.registry}>{children}</CommunityTestProvider> })
  const signal = hook.result.current.signal
  expect(accepted).not.toHaveBeenCalled()
  expect(hook.result.current.tryCapture()).toBeUndefined()
  expect(() => hook.result.current.capture()()).toThrow(expect.objectContaining({ name: "AbortError" }))
  act(() => {
    owner.registry.bindAuthentication(() => "viewer", async () => {})
    owner.registry.confirmAuthentication()
  })
  expect(accepted).toHaveBeenCalledOnce()
  expect(signal.aborted).toBe(true)
  const confirmedSignal = hook.result.current.signal
  const assert = accepted.mock.calls[0][0] as () => void
  expect(assert).not.toThrow()
  act(() => owner.registry.bindAuthentication(() => undefined, async () => {}))
  expect(hook.result.current.tryCapture()).toBeTypeOf("function")
  expect(hook.result.current.signal).toBe(confirmedSignal)
  expect(accepted).toHaveBeenCalledOnce()
  act(() => owner.registry.bindAuthentication(() => "B", async () => {}))
  expect(cleanup).toHaveBeenCalledOnce()
  expect(confirmedSignal.aborted).toBe(true)
  expect(hook.result.current.tryCapture()).toBeUndefined()
  expect(assert).toThrow(expect.objectContaining({ name: "AbortError" }))
  hook.unmount()
  expect(signal.aborted).toBe(true)
})

it("declines a capture after retirement and preserves unexpected errors", async () => {
  const owner = await createCommunityQueryOwner()
  const hook = renderHook(() => useCommunityViewSource("capture-errors"), {
    wrapper: ({ children }: React.PropsWithChildren) => <CommunityTestProvider client={owner.client} registry={owner.registry}>{children}</CommunityTestProvider>,
  })
  const check = vi.spyOn(owner.registry, "assertOnlineAccount").mockImplementation(() => { throw new Error("Unexpected guard failure") })
  expect(() => hook.result.current.tryCapture()).toThrow("Unexpected guard failure")
  check.mockRestore()
  act(() => hook.result.current.retire())
  expect(hook.result.current.tryCapture()).toBeUndefined()
  expect(() => hook.result.current.capture()()).toThrow(expect.objectContaining({ name: "AbortError" }))
})
