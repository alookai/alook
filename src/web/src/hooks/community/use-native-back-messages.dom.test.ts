import { createElement, StrictMode, useLayoutEffect } from "react"
import { act, render } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useNativeBackMessages } from "./use-native-back-messages"

const backEvent = "test-native-back-message"
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup(strict = false) {
  const bridge = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent<string>) => void) | null }
  vi.stubGlobal("AlookBack", bridge)
  let insets: ReturnType<typeof useNativeBackMessages> = null
  function Harness({ scope = "one" }: { scope?: string }) {
    const value = useNativeBackMessages(backEvent, scope)
    useLayoutEffect(() => { insets = value }, [value])
    return null
  }
  const back = vi.fn()
  window.addEventListener(backEvent, back)
  const view = render(strict ? createElement(StrictMode, null, createElement(Harness)) : createElement(Harness))
  const token = () => JSON.parse(bridge.postMessage.mock.calls.filter(([body]) => JSON.parse(body).type === "subscribe").at(-1)![0]).document as string
  const send = (fields: Record<string, unknown> = {}) => act(() => {
    bridge.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "complete", generation: 1, document: token(), href: location.href, ...fields }) }))
  })
  return { bridge, back, view, token, send, insets: () => insets, changeScope: () => view.rerender(createElement(Harness, { scope: "two" })),
    dispose: () => { view.unmount(); window.removeEventListener(backEvent, back) } }
}

describe("document-scoped confirmed Android Back", () => {
  it("forwards each fresh completion once without progress events", () => {
    const test = setup()
    const progress = vi.fn()
    window.addEventListener("alook:native-back-progress", progress)
    test.send(); test.send(); test.send({ generation: 3 }); test.send({ generation: 2 })
    expect(test.back).toHaveBeenCalledTimes(2)
    expect(test.back.mock.calls[0][0].cancelable).toBe(true)
    expect(progress).not.toHaveBeenCalled()
    window.removeEventListener("alook:native-back-progress", progress)
    test.dispose()
  })

  it("does not drive page motion from obsolete start,progress orcancel payloads", () => {
    const test = setup()
    for (const type of ["start", "progress", "cancel"]) test.send({ type, progress: .5 })
    expect(test.back).not.toHaveBeenCalled()
    test.send()
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
  })

  it("rejects other documents,hrefs and invalid generation values", () => {
    const test = setup()
    for (const fields of [{ document: "retired" }, { href: `${location.href}#old` }, { generation: 0 }, { generation: -1 }, { generation: .5 }, { generation: "1" }, { generation: Number.MAX_SAFE_INTEGER + 1 }]) test.send(fields)
    act(() => { test.bridge.onmessage?.(new MessageEvent("message", { data: "invalid-json" })) })
    expect(test.back).not.toHaveBeenCalled()
    test.send()
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
  })

  it("publishes only valid actual inset fractions and preserves equal identity", () => {
    const test = setup()
    const fields = { type: "insets", left: .08, right: .09 }
    for (const invalid of [{ left: -1 }, { right: -1 }, { left: .6, right: .5 }, { left: "0.08" }, { document: "retired" }]) test.send({ ...fields, ...invalid })
    expect(test.insets()).toBeNull()
    test.send(fields)
    expect(test.insets()).toEqual({ left: .08, right: .09 })
    const original = test.insets()
    test.send(fields)
    expect(test.insets()).toBe(original)
    test.dispose()
  })

  it("retires account/route scope and does not accept an old completion", () => {
    const test = setup()
    const old = test.token()
    test.send({ type: "insets", left: .1, right: .1 })
    test.changeScope()
    expect(test.token()).not.toBe(old)
    expect(test.insets()).toBeNull()
    test.send({ document: old })
    expect(test.back).not.toHaveBeenCalled()
    test.send()
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
  })

  it.each([false, true])("rebinds after BFCache restoration in StrictMode=%s", (strict) => {
    const test = setup(strict)
    const old = test.token()
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
    test.send()
    expect(test.back).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    expect(test.token()).not.toBe(old)
    test.send({ document: old }); test.send(); test.send()
    expect(test.back).toHaveBeenCalledOnce()
    test.dispose()
    expect(test.bridge.onmessage).toBeNull()
    expect(JSON.parse(test.bridge.postMessage.mock.calls.at(-1)![0]).type).toBe("unsubscribe")
  })
})
