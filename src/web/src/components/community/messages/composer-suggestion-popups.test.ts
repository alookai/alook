import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createPortal: vi.fn(),
  nextScrollTop: vi.fn(),
}))

vi.mock("react-dom", () => ({
  createPortal: (...args: unknown[]) => mocks.createPortal(...args),
}))
vi.mock("@/lib/community/popup-scroll", () => ({
  nextListScrollTop: (...args: unknown[]) => mocks.nextScrollTop(...args),
}))
vi.mock("../avatar", () => ({
  Avatar: (props: Record<string, unknown>) => createElement("avatar", props),
}))
vi.mock("../channels/channel-icon", () => ({
  ChannelIcon: (props: Record<string, unknown>) =>
    createElement("channel-icon", props),
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
  let listNode: {
    scrollTop: number
    clientHeight: number
    querySelector: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    const body = { nodeName: "BODY" }
    vi.stubGlobal("document", { body })
    vi.stubGlobal("window", {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }),
      cancelAnimationFrame: vi.fn(),
    })
    mocks.createPortal.mockReset()
    mocks.createPortal.mockImplementation((node) => node)
    mocks.nextScrollTop.mockReset()
    mocks.nextScrollTop.mockReturnValue(77)
    listNode = {
      scrollTop: 10,
      clientHeight: 100,
      querySelector: vi.fn(() => ({ offsetTop: 150, offsetHeight: 20 })),
    }
  })

  it("self-nulls while closed and preserves viewport placement", async () => {
    let mention!: TestRenderer.ReactTestRenderer
    let channel!: TestRenderer.ReactTestRenderer
    await act(async () => {
      mention = TestRenderer.create(
        createElement(CommunityMentionList, { state: EMPTY_MENTION_STATE }),
      )
      channel = TestRenderer.create(
        createElement(ChannelRefList, { state: EMPTY_CHANNEL_REF_STATE }),
      )
    })
    expect(mention.toJSON()).toBeNull()
    expect(channel.toJSON()).toBeNull()
    expect(mocks.createPortal).not.toHaveBeenCalled()

    await act(async () => {
      mention.update(
        createElement(CommunityMentionList, {
          state: {
            items: [{ kind: "everyone", id: "everyone", label: "everyone" }],
            selectedIndex: 0,
            command: vi.fn(),
            getRect: () => rect(500),
          },
        }),
      )
    })
    expect(mention.toJSON()).not.toBeNull()
    expect(mocks.createPortal).toHaveBeenLastCalledWith(
      expect.anything(),
      document.body,
    )

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
      selectedIndex: 1,
      command,
      getRect: () => rect(500),
    }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CommunityMentionList, { state }),
        {
          createNodeMock: (element) =>
            element.props.className?.includes("overflow-y-auto") ? listNode : {},
        },
      )
    })
    expect(mocks.createPortal).toHaveBeenCalledWith(
      expect.anything(),
      document.body,
    )
    expect(mocks.nextScrollTop).toHaveBeenCalledWith(10, 100, 150, 20)
    expect(listNode.scrollTop).toBe(77)
    const json = JSON.stringify(renderer.toJSON())
    expect(json.indexOf("@everyone")).toBeLessThan(json.indexOf("Members"))
    expect(json).toContain("Ada")
    expect(
      renderer.root.find(
        (node) =>
          node.type === "span" &&
          node.props.className?.includes("tracking-wide"),
      ).children,
    ).toEqual(["#", "0001"])
    expect(json).toContain("Notify everyone")

    const selected = renderer.root.find(
      (node) => node.type === "button" && node.props["aria-selected"] === true,
    )
    expect(selected.props.className).toContain("min-w-0")
    expect(selected.props.title).toBe("Ada#0001")
    expect(
      selected.findAll(
        (node) =>
          node.type === "span" &&
          node.props["data-suggestion-icon"] === true,
      ),
    ).toHaveLength(1)
    expect(
      selected.find(
        (node) =>
          node.type === "span" &&
          node.props.className?.includes("flex-1"),
      ).props.className,
    ).toContain("min-w-0")
    expect(
      selected.find(
        (node) =>
          node.type === "span" &&
          node.props["data-suggestion-label"] === true,
      ).props.className,
    ).toContain("truncate")
    expect(
      selected.find(
        (node) =>
          node.type === "span" &&
          node.props["data-suggestion-discriminator"] === true,
      ).props.className,
    ).toContain("shrink-0")
    const virtual = renderer.root.findAllByType("button")[0]
    expect(virtual.props.title).toBe("@everyone")
    expect(
      virtual.find(
        (node) =>
          node.type === "span" &&
          node.props.className?.includes("bg-primary/15"),
      ).props.className,
    ).toContain("shrink-0")
    expect(
      virtual.find(
        (node) =>
          node.type === "span" &&
          node.children.includes("Notify everyone"),
      ).props.className,
    ).toContain("shrink-0")
    const preventDefault = vi.fn()
    await act(async () => selected.props.onMouseDown({ preventDefault }))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith({ id: "member-1", label: "Ada#0001" })
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
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ChannelRefList, { state }), {
        createNodeMock: (element) =>
          element.props.className?.includes("overflow-y-auto") ? listNode : {},
      })
    })
    const prefixes = renderer.root
      .findAll(
        (node) =>
          node.type === "span" &&
          node.props.className === "text-muted-foreground",
      )
      .map((node) => node.children)
    expect(prefixes).toEqual([
      ["One", " / "],
      ["Two", " / "],
    ])

    const first = renderer.root.findAllByType("button")[0]
    expect(first.props["data-testid"]).toBe("community-channel-ref-option-channel-1")
    expect(first.props.className).toContain("min-w-0")
    expect(first.props.title).toBe("One / general")
    expect(
      first.find(
        (node) =>
          node.type === "span" &&
          node.props["data-suggestion-icon"] === true,
      ).props.className,
    ).toContain("shrink-0")
    expect(
      first.find(
        (node) =>
          node.type === "span" &&
          node.props["data-suggestion-label"] === true,
      ).props.className,
    ).toContain("min-w-0")
    expect(
      first.find(
        (node) =>
          node.type === "span" &&
          node.props["data-suggestion-label"] === true,
      ).props.className,
    ).toContain("truncate")
    const preventDefault = vi.fn()
    await act(async () => first.props.onMouseDown({ preventDefault }))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith({
      id: "channel-1",
      label: "general",
      serverId: "server-1",
      serverName: "One",
      serverDiscriminator: "0001",
    })

    await act(async () => {
      renderer.update(
        createElement(ChannelRefList, {
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
        }),
      )
    })
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === "span" &&
          node.props.className === "text-muted-foreground",
      ),
    ).toHaveLength(0)
  })
})
