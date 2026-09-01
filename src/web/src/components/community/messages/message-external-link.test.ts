import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  copyMessageExternalLink,
  MESSAGE_EXTERNAL_LINK_COPY_ERROR,
  MESSAGE_EXTERNAL_LINK_COPY_SUCCESS,
  MESSAGE_EXTERNAL_LINK_ERROR,
  MessageExternalLink,
  handleMessageExternalLinkClick,
  messageExternalLinkTargetFromEventTarget,
  openMessageExternalLink,
} from "./message-external-link"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}))

afterEach(() => {
  vi.clearAllMocks()
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

describe("messageExternalLinkTargetFromEventTarget", () => {
  it("resolves the exact second marked anchor with its complete live href", () => {
    const first = { href: "https://example.com/first" }
    const second = {
      href: "https://example.com/second/path?from=message&mode=full#details",
    }
    const target = {
      closest: vi.fn((selector: string) => {
        expect(selector).toBe("a[data-message-external-link]")
        return second
      }),
    }

    expect(messageExternalLinkTargetFromEventTarget(target as unknown as EventTarget)).toEqual({
      href: second.href,
    })
    expect(messageExternalLinkTargetFromEventTarget({
      closest: () => first,
    } as unknown as EventTarget)).toEqual({ href: first.href })
  })

  it.each([
    ["non-link", { closest: () => null }],
    ["relative app route", { closest: () => ({ href: "/c/channels/s1/c1" }) }],
    ["mailto", { closest: () => ({ href: "mailto:friend@example.com" }) }],
    ["invalid", { closest: () => ({ href: "not a url" }) }],
  ])("rejects a %s target", (_case, target) => {
    expect(messageExternalLinkTargetFromEventTarget(target as unknown as EventTarget)).toBeNull()
  })
})

describe("message external-link menu actions", () => {
  const target = { href: "https://example.com/story?from=message#section" }

  it("copies the exact href and reports visible success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)

    await expect(copyMessageExternalLink(target, { writeText })).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(target.href)
    expect(toast).toHaveBeenCalledWith(MESSAGE_EXTERNAL_LINK_COPY_SUCCESS)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    ["missing", null],
    ["rejected", vi.fn().mockRejectedValue(new Error("denied"))],
  ])("reports visible copy failure when clipboard access is %s", async (_case, writeText) => {
    await expect(copyMessageExternalLink(target, { writeText })).resolves.toBe(false)

    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith(MESSAGE_EXTERNAL_LINK_COPY_ERROR)
  })

  it.each([
    ["a Window proxy", {} as Window],
    ["the normal null result from an isolated opener", null],
  ])("opens browser Web exactly once with opener isolation when it returns %s", async (_case, result) => {
    const openWindow = vi.fn(() => result)

    await openMessageExternalLink(target, { tauri: false, openWindow })

    expect(openWindow).toHaveBeenCalledOnce()
    expect(openWindow).toHaveBeenCalledWith(
      target.href,
      "_blank",
      "noopener,noreferrer",
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("uses the #53 Tauri system-browser opener exactly once", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    const openWindow = vi.fn()

    await openMessageExternalLink(target, { tauri: true, openUrl, openWindow })

    expect(openUrl).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledWith(target.href)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it.each([
    ["missing browser API", { tauri: false, openWindow: null }],
    ["throwing browser API", { tauri: false, openWindow: () => { throw new Error("blocked") } }],
    ["missing Tauri API", { tauri: true, openUrl: null }],
    ["rejected Tauri API", { tauri: true, openUrl: vi.fn().mockRejectedValue(new Error("denied")) }],
  ])("reports visible open failure for %s", async (_case, options) => {
    await openMessageExternalLink(target, options)

    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith(MESSAGE_EXTERNAL_LINK_ERROR)
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
