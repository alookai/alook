import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { MessageHeader, MessageHeaderMobileBack } from "./message-header"

describe("MessageHeader", () => {
  it("owns one stable left / identity / actions frame", () => {
    const html = renderToStaticMarkup(createElement(MessageHeader, {
      leading: createElement("span", { "data-zone": "leading" }),
      identity: createElement("span", null, "Identity"),
      actions: createElement("button", null, "Action"),
    }))

    expect(html).toContain("h-12")
    expect(html).toContain('data-zone="leading"')
    expect(html).toContain('data-slot="message-header-identity"')
    expect(html).toContain('data-slot="message-header-actions"')
  })

  it("keeps explicit parent navigation mobile-only with a 44px target", () => {
    const onNavigate = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(MessageHeaderMobileBack, { onNavigate }))
    })

    const back = renderer.root.findByProps({ "aria-label": "Back" })
    expect(back.props.className).toContain("size-11")
    expect(back.props.className).toContain("sm:hidden")
    act(() => back.props.onClick())
    expect(onNavigate).toHaveBeenCalledOnce()
  })
})
