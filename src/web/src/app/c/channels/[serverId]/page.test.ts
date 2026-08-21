import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ServerDefaultPage from "./page"

const mocks = vi.hoisted(() => ({
  breakpoint: { current: "mobile" as "mobile" | "desktop" | "unknown" },
  lastChannel: { current: null as string | null },
  replace: vi.fn(),
  search: { current: "" },
  server: { current: null as null | {
    categories: Array<{ channels: Array<{ id: string }> }>
  } },
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "server_1" }),
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  useServer: () => ({ server: mocks.server.current }),
}))
vi.mock("@/hooks/use-mobile", () => ({
  useBreakpoint: () => mocks.breakpoint.current,
}))
vi.mock("@/lib/community/last-channel", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/last-channel")>(
    "@/lib/community/last-channel",
  )
  return {
    ...actual,
    getLastChannel: () => mocks.lastChannel.current,
  }
})
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: (props: Record<string, unknown>) => createElement("message-list", props),
}))
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: Record<string, unknown>) => createElement("skeleton-row", props),
}))

beforeEach(() => {
  mocks.breakpoint.current = "mobile"
  mocks.lastChannel.current = null
  mocks.replace.mockClear()
  mocks.search.current = ""
  mocks.server.current = {
    categories: [{ channels: [{ id: "channel_1" }, { id: "channel_2" }] }],
  }
})

describe("ServerDefaultPage checkpoint route contract", () => {
  it("keeps the mobile server root on the list route without rendering detail", async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerDefaultPage))
    })

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(renderer.toJSON()).toBeNull()
  })

  it("replaces the desktop server root with the remembered channel and preserves search", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.lastChannel.current = "channel_2"
    mocks.search.current = "settings=1"
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerDefaultPage))
    })

    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_2?settings=1",
    )
    expect(renderer.root.findAllByType("message-list")).toHaveLength(1)
  })

  it("falls back to the first top-level channel on desktop", async () => {
    mocks.breakpoint.current = "desktop"

    await act(async () => {
      TestRenderer.create(createElement(ServerDefaultPage))
    })

    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1",
    )
  })

  it("keeps an empty desktop server on its root with an empty state", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.server.current = { categories: [{ channels: [] }] }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerDefaultPage))
    })

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType("message-list")).toHaveLength(0)
    expect(renderer.root.findAllByType("span").map((node) => node.children.join(" "))).toEqual([
      "No channels yet",
      "Create a channel from the sidebar to get started.",
    ])
  })
})
