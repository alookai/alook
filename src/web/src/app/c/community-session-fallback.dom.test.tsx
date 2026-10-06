import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({ pathname: "/c", pending: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }))
vi.mock("@/components/community/shell/community-session-pending-frame", () => ({
  CommunitySessionPendingFrame: (props: { pathname: string }) => {
    mocks.pending(props)
    return createElement("div", { "data-testid": "pending", "data-pathname": props.pathname })
  },
}))

import { CommunitySessionFallback } from "./community-session-fallback"

describe("CommunitySessionFallback route adapter", () => {
  beforeEach(() => {
    mocks.pending.mockClear()
    mocks.pathname = "/c"
  })

  it.each(["/c", "/c/channels/server-a/channel-a", "/c/invite/token", "/c/invite/token/extra"])(
    "passes only the current pathname %s to the public frame", (pathname) => {
      mocks.pathname = pathname
      render(createElement(CommunitySessionFallback))
      expect(screen.getByTestId("pending")).toHaveAttribute("data-pathname", pathname)
      expect(mocks.pending).toHaveBeenCalledWith({ pathname })
    },
  )

  it("updates the public geometry input when the current route changes", () => {
    const rendered = render(createElement(CommunitySessionFallback))
    mocks.pathname = "/c/me/dm-b"
    rendered.rerender(createElement(CommunitySessionFallback))
    expect(screen.getByTestId("pending")).toHaveAttribute("data-pathname", "/c/me/dm-b")
    expect(mocks.pending).toHaveBeenLastCalledWith({ pathname: "/c/me/dm-b" })
  })
})
