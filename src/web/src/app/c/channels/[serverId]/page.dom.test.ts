import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"
import ServerDefaultPage from "@/components/community/shell/server-landing-route"
import { tid } from "@/lib/community/testids"
import { CommunityServerRouteContext } from "@/components/community/shell/community-route-context"

import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { CommunityRouteContext } from "@/contexts/community/route-frame"

const mocks = vi.hoisted(() => ({
  breakpoint: { current: "mobile" as "mobile" | "desktop" | "unknown" },
  lastChannel: { current: null as string | null },
  replace: vi.fn(),
  search: { current: "" },
  server: { current: null as null | {
    categories: Array<{ channels: Array<{ id: string }> }>
  } },
}))

vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({
  AlookLoading: () => null,
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "wrong_sidebar_server" }),
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
    const rendered = render(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container).toBeEmptyDOMElement()
  })

  it("keeps cold or incomplete detail on the root, then redirects only when canonical detail is known", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.server.current = null
    const rendered = render(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(screen.getByTestId(tid.pendingMain("server-landing"))).toHaveAttribute("data-community-target-href", "/c/channels/server_1")
    expect(screen.getByRole("main", { name: "Loading server" })).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("main", { name: "Loading server" }))
      .not.toHaveAttribute("data-community-mobile-transition")
    expect(rendered.container.querySelectorAll("header, button, form, textarea")).toHaveLength(0)

    mocks.server.current = { categories: [{ channels: [{ id: "channel_ready" }] }] }
    rendered.rerender(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/channels/server_1/channel_ready")
    expect(screen.getByRole("main", { name: "Loading server" })).toBeInTheDocument()
  })

  it("replaces the desktop server root with the remembered channel and preserves search", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.lastChannel.current = "channel_2"
    mocks.search.current = "settings=1"
    render(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))

    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_2?settings=1",
    )
    expect(screen.getByRole("main", { name: "Loading server" })).toBeInTheDocument()
  })

  it("does not enqueue the same landing redirect again while restored detail reconciles", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.lastChannel.current = "channel_2"
    const rendered = render(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))

    mocks.server.current = {
      categories: [{ channels: [{ id: "channel_1" }, { id: "channel_2" }] }],
    }
    rendered.rerender(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      "/c/channels/server_1/channel_2",
    )

    mocks.lastChannel.current = null
    mocks.server.current = { categories: [{ channels: [{ id: "channel_3" }] }] }
    rendered.rerender(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))
    expect(mocks.replace).toHaveBeenNthCalledWith(
      2,
      "/c/channels/server_1/channel_3",
    )
  })

  it("falls back to the first top-level channel on desktop", async () => {
    mocks.breakpoint.current = "desktop"

    render(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))

    expect(mocks.replace).toHaveBeenCalledWith(
      "/c/channels/server_1/channel_1",
    )
  })

  it("keeps an empty desktop server on its root with an empty state", async () => {
    mocks.breakpoint.current = "desktop"
    mocks.server.current = { categories: [{ channels: [] }] }
    const rendered = render(createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))

    expect(mocks.replace).not.toHaveBeenCalled()
    expect(rendered.container.querySelector("[aria-label='Loading server']")).not.toBeInTheDocument()
    expect(screen.getByText("No channels yet")).toBeInTheDocument()
    expect(screen.getByText("Create a channel from the sidebar to get started.")).toBeInTheDocument()
  })
})


it("submits the pending target root destination through its intent owner with target search", () => {
  mocks.breakpoint.current = "desktop"
  mocks.search.current = "wrong=old"
  const replace = vi.fn()
  render(createElement(CommunityRouteContext, { value: { navigation: { replace } } as never },
    createElement(CommunityModuleRouteContext, { value: { href: "/c/channels/server_1?invite=1", routeCommitted: false } },
      createElement(CommunityServerRouteContext, { value: { serverId: "server_1", serverParam: "server_1" } }, createElement(ServerDefaultPage)))))
  expect(replace).toHaveBeenCalledExactlyOnceWith("/c/channels/server_1/channel_1?invite=1")
  expect(mocks.replace).not.toHaveBeenCalled()
})
