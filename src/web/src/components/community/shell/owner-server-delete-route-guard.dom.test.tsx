import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  pathname: "/c/channels/deleted/channel-1",
  completed: true,
  runEject: vi.fn(() => true),
  replace: vi.fn(),
  getQueryData: vi.fn(() => ({ servers: [{ id: "survivor" }] })),
  getQueryState: vi.fn(() => ({ status: "success", fetchStatus: "idle" })),
  subscribe: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    getQueryData: mocks.getQueryData,
    getQueryState: mocks.getQueryState,
    getQueryCache: () => ({
      subscribe: mocks.subscribe,
      find: () => ({ queryHash: "servers" }),
    }),
  }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer-1" }),
}))
vi.mock("@/lib/community/eject-server", () => ({
  consumeVoluntaryLeave: vi.fn(),
  isOwnerServerDeleteCompleted: () => mocks.completed,
  runAuthoritativeServerEject: mocks.runEject,
}))
vi.mock("@/lib/community/last-channel", () => ({ clearLastChannel: vi.fn() }))

import { OwnerServerDeleteRouteGuard } from "./owner-server-delete-route-guard"

describe("OwnerServerDeleteRouteGuard", () => {
  beforeEach(() => {
    mocks.pathname = "/c/channels/deleted/channel-1"
    mocks.completed = true
    mocks.runEject.mockClear()
    mocks.getQueryData.mockClear()
    mocks.getQueryState.mockClear()
    mocks.subscribe.mockReset()
  })

  it("rechecks a completed delete from cached server-list state without mounting a query observer", () => {
    render(createElement(OwnerServerDeleteRouteGuard))

    expect(mocks.runEject).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "deleted",
      servers: [{ id: "survivor" }],
      isSuccess: true,
      isFetching: false,
      routeHref: "/c/channels/deleted/channel-1",
    }))
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })

  it("does not touch the server-list cache for ordinary routes", () => {
    mocks.completed = false
    render(createElement(OwnerServerDeleteRouteGuard))

    expect(mocks.runEject).not.toHaveBeenCalled()
    expect(mocks.getQueryData).not.toHaveBeenCalled()
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })
})
