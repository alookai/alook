import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { FriendsPage } from "./friends-page"

function renderFriendsPage(props: Parameters<typeof FriendsPage>[0]) {
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(FriendsPage, props),
  ))
}

describe("FriendsPage loading header", () => {
  it("keeps Back geometry inert until the real page is loaded", () => {
    const html = renderFriendsPage({
      friends: [],
      pending: [],
      blocked: [],
      loading: true,
      onBack: vi.fn(),
    })

    expect(html).toContain('data-slot="loading-back-placeholder"')
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<input")
    expect(html).not.toContain('aria-label="Back"')
  })

  it("keeps the real Back control during a warm-data refresh", () => {
    const html = renderFriendsPage({
      friends: [{
        id: "friend_1",
        userId: "user_1",
        name: "Alice",
        discriminator: "0001",
        avatar: "A",
        status: "online",
      }],
      pending: [],
      blocked: [],
      loading: true,
      onBack: vi.fn(),
    })

    expect(html).toContain('aria-label="Back"')
  })
})
