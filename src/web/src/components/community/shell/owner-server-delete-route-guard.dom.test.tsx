import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  pathname: "/c/channels/deleted/channel-1",
  completed: true,
  runEject: vi.fn(() => true),
  replace: vi.fn(),
  servers: [{ id: "survivor" }],
  isSuccess: true,
  isFetching: false,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@/hooks/community/use-servers", () => ({
  useServers: () => ({
    servers: mocks.servers,
    isSuccess: mocks.isSuccess,
    isFetching: mocks.isFetching,
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
  })

  it("rechecks a completed delete from the official server projection", () => {
    render(createElement(OwnerServerDeleteRouteGuard))

    expect(mocks.runEject).toHaveBeenCalledWith(expect.objectContaining({
      serverId: "deleted",
      servers: [{ id: "survivor" }],
      isSuccess: true,
      isFetching: false,
      routeHref: "/c/channels/deleted/channel-1",
    }))
  })

  it("does not eject ordinary routes", () => {
    mocks.completed = false
    render(createElement(OwnerServerDeleteRouteGuard))

    expect(mocks.runEject).not.toHaveBeenCalled()
  })
})
