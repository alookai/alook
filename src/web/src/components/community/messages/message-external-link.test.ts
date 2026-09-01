import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  MESSAGE_EXTERNAL_LINK_ERROR,
  MessageExternalLink,
  handleMessageExternalLinkClick,
} from "./message-external-link"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

afterEach(() => {
  vi.unstubAllGlobals()
})

function clickEvent(defaultPrevented = false) {
  return {
    defaultPrevented,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }
}

describe("handleMessageExternalLinkClick", () => {
  it.each([
    "http://example.com:8080/path/to/story?source=chat#section",
    "https://github.com/alookai/alook/pull/598?view=files#diff",
    "https://alook.ai/blog/native-links?from=message#intro",
    "https://alook.ai/c/invite/abcdef?from=dm",
  ])("opens an absolute Tauri HTTP(S) URL exactly once without WebView navigation: %s", async (href) => {
    const event = clickEvent()
    const order: string[] = []
    event.preventDefault.mockImplementation(() => { order.push("prevent") })
    const openUrl = vi.fn(async () => { order.push("open") })
    const onError = vi.fn()

    const opening = handleMessageExternalLinkClick(event, href, {
      tauri: true,
      openUrl,
      onError,
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledWith(href)
    expect(order).toEqual(["prevent", "open"])
    await opening
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([
    ["ordinary Web", false, "https://example.com"],
    ["relative App route", true, "/c/channels/server/channel"],
    ["mailto", true, "mailto:friend@example.com"],
    ["tel", true, "tel:+15551234567"],
    ["invalid URL", true, "not a URL"],
  ])("leaves %s to its existing browser or App behavior", (_case, tauri, href) => {
    const event = clickEvent()
    const openUrl = vi.fn()

    expect(handleMessageExternalLinkClick(event, href, { tauri, openUrl })).toBeNull()

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })

  it("respects a caller that already prevented the click", () => {
    const event = clickEvent(true)
    const openUrl = vi.fn()

    expect(handleMessageExternalLinkClick(event, "https://example.com", {
      tauri: true,
      openUrl,
    })).toBeNull()

    expect(openUrl).not.toHaveBeenCalled()
  })

  it("fails closed with one visible error when an old bundle has no opener API", async () => {
    vi.mocked(toast.error).mockReset()
    const event = clickEvent()

    await handleMessageExternalLinkClick(event, "https://example.com", {
      tauri: true,
      openUrl: null,
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith(MESSAGE_EXTERNAL_LINK_ERROR)
  })

  it.each([
    ["asynchronously", () => Promise.reject(new Error("denied"))],
    ["synchronously", () => { throw new Error("missing command") }],
  ])("fails closed with one visible error when opener rejects %s", async (_case, implementation) => {
    const event = clickEvent()
    const openUrl = vi.fn(implementation)
    const onError = vi.fn()

    await handleMessageExternalLinkClick(event, "https://example.com", {
      tauri: true,
      openUrl,
      onError,
    })

    expect(openUrl).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledOnce()
  })
})

describe("MessageExternalLink", () => {
  it("preserves anchor attributes and marks the shared external-link surface", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageExternalLink, {
          href: "https://example.com/story",
          target: "_blank",
          rel: "noopener noreferrer",
        }, "Example"),
      )
    })

    expect(renderer!.root.findByType("a").props).toMatchObject({
      href: "https://example.com/story",
      target: "_blank",
      rel: "noopener noreferrer",
      "data-message-external-link": true,
    })
  })

  it("uses the registered global Tauri opener from the rendered anchor", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("window", { __TAURI__: { opener: { openUrl } } })
    const event = clickEvent()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(MessageExternalLink, {
          href: "https://example.com/native",
        }, "Example"),
      )
    })

    await act(async () => {
      renderer!.root.findByType("a").props.onClick(event)
      await Promise.resolve()
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledWith("https://example.com/native")
  })
})
