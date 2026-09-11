import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/community/billing/billing-plan.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("@/components/community/shell/community-shell-layout", () => ({
  CommunityShellLayout: ({ main }: { main: ReactNode }) => main,
}))

import FriendsLoading from "@/app/c/me/friends/loading"
import { CommunityPendingFrame } from "./community-pending-frame"
import { CommunitySessionPendingFrame } from "./community-session-pending-frame"

function prerender(node: ReactNode, withQueryProvider: boolean) {
  const tree = withQueryProvider
    ? createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        node,
      )
    : node

  return renderToStaticMarkup(tree)
}

describe("friends pending QueryClient provider order", () => {
  it.each([
    {
      name: "the pre-auth community session frame",
      render: () => createElement(CommunitySessionPendingFrame, {
        pathname: "/c/me/friends",
      }),
      withQueryProvider: false,
    },
    {
      name: "the friends route loading boundary",
      render: () => createElement(FriendsLoading),
      withQueryProvider: false,
    },
    {
      name: "the authenticated shared pending frame",
      render: () => createElement(CommunityPendingFrame, {
        href: "/c/me/friends",
      }),
      withQueryProvider: true,
    },
  ])("prerenders $name without requiring a misplaced provider", ({
    render,
    withQueryProvider,
  }) => {
    const html = prerender(render(), withQueryProvider)

    expect(html).toContain('aria-label="Loading friends"')
    expect(html).toContain('data-testid="community-pending-main-friends"')
  })
})
