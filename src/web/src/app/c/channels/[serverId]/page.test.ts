import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ServerDefaultPage from "./page"
import { UnresolvedMainSkeleton } from "@/components/community/shell/unresolved-main-skeleton"

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
  it.each(["mobile", "unknown"] as const)("keeps the %s server root on the list route without rendering detail", async (breakpoint) => {
    mocks.breakpoint.current = breakpoint
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerDefaultPage))
    })

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(renderer.toJSON()).toBeNull()
  })

  it("keeps metadata loading neutral, then redirects only when the target is known", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.server.current = null
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ServerDefaultPage))
    })

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType(UnresolvedMainSkeleton)).toHaveLength(1)
    expect(renderer.root.findByType("main").props).toMatchObject({
      "aria-label": "Loading server",
      "aria-busy": "true",
      "data-community-mobile-transition": "suppress",
    })
    expect(renderer.root.findAll((node) => typeof node.type === "string"
      && ["header", "button", "form", "textarea"].includes(node.type))).toHaveLength(0)

    mocks.server.current = { categories: [{ channels: [{ id: "channel_ready" }] }] }
    await act(async () => { renderer.update(createElement(ServerDefaultPage)) })
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/channels/server_1/channel_ready")
    expect(renderer.root.findAllByType(UnresolvedMainSkeleton)).toHaveLength(1)
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
    expect(renderer.root.findAllByType(UnresolvedMainSkeleton)).toHaveLength(1)
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
    expect(renderer.root.findAllByType(UnresolvedMainSkeleton)).toHaveLength(0)
    expect(renderer.root.findAllByType("span").map((node) => node.children.join(" "))).toEqual([
      "No channels yet",
      "Create a channel from the sidebar to get started.",
    ])
  })
})
