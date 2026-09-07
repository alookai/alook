import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  createPortal: vi.fn(),
  nextScrollTop: vi.fn(),
}))

vi.mock("react-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-dom")>(),
  createPortal: (...args: unknown[]) => mocks.createPortal(...args),
}))
vi.mock("@/lib/community/popup-scroll", () => ({
  nextListScrollTop: (...args: unknown[]) => mocks.nextScrollTop(...args),
}))
vi.mock("../avatar", () => ({
  Avatar: (props: Record<string, unknown>) => createElement("span", { ...props, "data-avatar": "" }),
}))
vi.mock("../channels/channel-icon", () => ({
  ChannelIcon: (props: Record<string, unknown>) =>
    createElement("span", { ...props, "data-channel-icon": "" }),
}))

import {
  ChannelRefList,
  CommunityMentionList,
} from "./composer-suggestion-popups"
import {
  EMPTY_CHANNEL_REF_STATE,
  type ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"
import {
  EMPTY_MENTION_STATE,
  type MentionPopupState,
} from "@/lib/community/mention-extension"

function rect(top: number, left = 40): DOMRect {
  return {
    top,
    bottom: top + 16,
    left,
    right: left + 4,
    width: 4,
    height: 16,
    x: left,
    y: top,
    toJSON() {},
  }
}

describe("Composer suggestion popups", () => {
  let listScrollTop = 10
  const descriptors = new Map<string, PropertyDescriptor | undefined>()

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 })
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
      writable: true,
    })
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 1
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
    mocks.createPortal.mockReset()
    mocks.createPortal.mockImplementation((node) => node)
    mocks.nextScrollTop.mockReset()
    mocks.nextScrollTop.mockReturnValue(77)
    listScrollTop = 10
    for (const property of ["clientHeight", "scrollTop", "offsetTop", "offsetHeight"]) {
      descriptors.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property))
    }
    const isList = (element: HTMLElement) => element.className.includes("overflow-y-auto")
    Object.defineProperties(HTMLElement.prototype, {
      clientHeight: {
        configurable: true,
        get() { return isList(this) ? 100 : 0 },
      },
      scrollTop: {
        configurable: true,
        get() { return isList(this) ? listScrollTop : 0 },
        set(value: number) { if (isList(this)) listScrollTop = value },
      },
      offsetTop: {
        configurable: true,
        get() { return this.getAttribute("aria-selected") === "true" ? 150 : 0 },
      },
      offsetHeight: {
        configurable: true,
        get() { return this.getAttribute("aria-selected") === "true" ? 20 : 0 },
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const [property, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property]
    }
    descriptors.clear()
  })

  it("self-nulls while closed and preserves viewport placement", async () => {
    const mention = render(createElement(CommunityMentionList, {
      state: EMPTY_MENTION_STATE,
      presentation: { status: "ready" },
    }))
    const channel = render(createElement(ChannelRefList, { state: EMPTY_CHANNEL_REF_STATE }))
    expect(mention.container).toBeEmptyDOMElement()
    expect(channel.container).toBeEmptyDOMElement()
    expect(mocks.createPortal).not.toHaveBeenCalled()

    mention.rerender(createElement(CommunityMentionList, {
      state: {
        items: [{ kind: "everyone", id: "everyone", label: "everyone" }],
        query: "",
        selectedIndex: 0,
        command: vi.fn(),
        getRect: () => rect(500),
      },
      presentation: { status: "ready" },
    }))
    expect(mention.container).not.toBeEmptyDOMElement()
    expect(mocks.createPortal).toHaveBeenLastCalledWith(
      expect.anything(),
      document.body,
    )

  })

  it("projects mention and channel popups through the same add-once viewport geometry", async () => {
    Object.assign(window, {
      visualViewport: {
        offsetTop: 100,
        offsetLeft: 20,
        width: 320,
        height: 500,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })
    const mentionState: MentionPopupState = {
      items: [{ kind: "everyone", id: "everyone", label: "everyone" }],
      query: "",
      selectedIndex: 0,
      command: vi.fn(),
      getRect: () => rect(400),
    }
    const channelState: ChannelRefPopupState = {
      items: [{
        id: "channel-1",
        name: "general",
        serverId: "server-1",
        serverName: "One",
        serverDiscriminator: "0001",
      }],
      selectedIndex: 0,
      command: vi.fn(),
      getRect: () => rect(400),
    }
    const mention = render(createElement(CommunityMentionList, {
      state: mentionState,
      presentation: { status: "ready" },
    }))
    const channel = render(createElement(ChannelRefList, { state: channelState }))

    const expectedProjection = expect.objectContaining({
      left: "60px",
      top: "496px",
      transform: "translateY(-100%)",
    })
    expect(mention.container.querySelector<HTMLElement>(
      '[data-testid="community-mention-popup"]',
    )?.style).toMatchObject(expectedProjection)
    expect(channel.container.querySelector<HTMLElement>(
      '[data-testid="community-channel-ref-popup"]',
    )?.style).toMatchObject(expectedProjection)
  })

  it("renders virtual/member rows in order and selects on mousedown", async () => {
    const command = vi.fn()
    const state: MentionPopupState = {
      items: [
        { kind: "everyone", id: "everyone", label: "everyone" },
        {
          kind: "member",
          id: "member-1",
          userId: "user-1",
          label: "Ada#0001",
          name: "Ada",
          discriminator: "0001",
          avatar: "A",
          status: "online",
        },
      ],
      query: "",
      selectedIndex: 1,
      command,
      getRect: () => rect(500),
    }
    const renderer = render(createElement(CommunityMentionList, {
      state,
      presentation: { status: "ready" },
    }))
    expect(mocks.createPortal).toHaveBeenCalledWith(
      expect.anything(),
      document.body,
    )
    expect(mocks.nextScrollTop).toHaveBeenCalledWith(10, 100, 150, 20)
    expect(listScrollTop).toBe(77)
    const text = renderer.container.textContent ?? ""
    expect(text.indexOf("@everyone")).toBeLessThan(text.indexOf("Members"))
    expect(text).toContain("Ada")
    expect(renderer.container.querySelector('[class*="tracking-wide"]')?.textContent)
      .toBe("#0001")
    expect(text).toContain("Notify everyone")

    const selected = renderer.container.querySelector<HTMLButtonElement>(
      'button[aria-selected="true"]',
    )!
    expect(selected.className).toContain("min-w-0")
    expect(selected.title).toBe("Ada#0001")
    expect(selected.querySelectorAll("[data-suggestion-icon]")).toHaveLength(1)
    expect(selected.querySelector('[class*="flex-1"]')?.className).toContain("min-w-0")
    expect(selected.querySelector("[data-suggestion-label]")?.className).toContain("truncate")
    expect(selected.querySelector("[data-suggestion-discriminator]")?.className)
      .toContain("shrink-0")
    const virtual = renderer.container.querySelectorAll("button")[0]!
    expect(virtual.title).toBe("@everyone")
    expect(virtual.querySelector('[class*="bg-primary/15"]')?.className).toContain("shrink-0")
    expect([...virtual.querySelectorAll("span")]
      .find((node) => node.textContent === "Notify everyone")?.className).toContain("shrink-0")
    fireEvent.mouseDown(selected)
    expect(command).toHaveBeenCalledWith({ id: "member-1", label: "Ada#0001" })
  })

  it("keeps one anchored frame for loading, empty, error, and loading-more", async () => {
    const state: MentionPopupState = {
      items: [],
      query: "ada",
      selectedIndex: 0,
      command: vi.fn(),
      getRect: () => rect(500),
    }
    const renderer = render(createElement(CommunityMentionList, {
      state,
      presentation: { status: "loading" },
    }))
    expect(renderer.container.querySelector('[data-state="loading"]')?.textContent)
      .toBe("Loading members…")

    for (const [status, label] of [
      ["empty", "No matching members"],
      ["error", "Couldn’t load members"],
      ["loading-more", "Loading members…"],
    ] as const) {
      renderer.rerender(createElement(CommunityMentionList, {
        state,
        presentation: { status },
      }))
      expect(renderer.container.querySelector(`[data-state="${status}"]`)?.textContent)
        .toBe(label)
    }
  })

  it("keeps one anchored channel frame for loading, empty, and error", async () => {
    const state: ChannelRefPopupState = {
      items: [],
      selectedIndex: 0,
      command: vi.fn(),
      getRect: () => rect(500),
    }
    const renderer = render(createElement(ChannelRefList, {
      state,
      presentation: { status: "loading" },
    }))
    expect(renderer.container.querySelector(
      '[data-testid="community-channel-ref-popup"]',
    )).not.toBeNull()
    expect(renderer.container.querySelector(
      '[data-testid="community-channel-ref-status"][data-state="loading"]',
    )?.textContent).toBe("Loading channels…")

    for (const [status, label] of [
      ["empty", "No matching channels"],
      ["error", "Couldn’t load channels"],
    ] as const) {
      renderer.rerender(createElement(ChannelRefList, {
        state,
        presentation: { status },
      }))
      expect(renderer.container.querySelector(
        `[data-testid="community-channel-ref-status"][data-state="${status}"]`,
      )?.textContent).toBe(label)
    }

    renderer.rerender(createElement(ChannelRefList, { state }))
    expect(renderer.container).toBeEmptyDOMElement()
  })

  it("adds server prefixes only for cross-server channel results", async () => {
    const command = vi.fn()
    const state: ChannelRefPopupState = {
      items: [
        {
          id: "channel-1",
          name: "general",
          serverId: "server-1",
          serverName: "One",
          serverDiscriminator: "0001",
        },
        {
          id: "channel-2",
          name: "random",
          serverId: "server-2",
          serverName: "Two",
          serverDiscriminator: "0002",
        },
      ],
      selectedIndex: 0,
      command,
      getRect: () => rect(500),
    }
    const renderer = render(createElement(ChannelRefList, { state }))
    const prefixes = [...renderer.container.querySelectorAll('span[class="text-muted-foreground"]')]
      .map((node) => [...node.childNodes].map((child) => child.textContent))
    expect(prefixes).toEqual([
      ["One", " / "],
      ["Two", " / "],
    ])

    const first = renderer.container.querySelectorAll("button")[0]!
    expect(first.getAttribute("data-testid")).toBe("community-channel-ref-option-channel-1")
    expect(first.className).toContain("min-w-0")
    expect(first.title).toBe("One / general")
    expect(first.querySelector("[data-suggestion-icon]")?.className).toContain("shrink-0")
    expect(first.querySelector("[data-suggestion-label]")?.className).toContain("min-w-0")
    expect(first.querySelector("[data-suggestion-label]")?.className).toContain("truncate")
    fireEvent.mouseDown(first)
    expect(command).toHaveBeenCalledWith({
      id: "channel-1",
      label: "general",
      serverId: "server-1",
      serverName: "One",
      serverDiscriminator: "0001",
    })

    renderer.rerender(createElement(ChannelRefList, {
      state: {
        ...state,
        items: [
          state.items[0],
          {
            ...state.items[1],
            serverId: "server-1",
            serverName: "One",
            serverDiscriminator: "0001",
          },
        ],
      },
    }))
    expect(renderer.container.querySelectorAll('span[class="text-muted-foreground"]'))
      .toHaveLength(0)
  })
})
