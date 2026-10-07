import { PassThrough } from "node:stream"
import { createElement, type ReactNode } from "react"
import { renderToPipeableStream } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CurrentUser } from "@/contexts/community/current-user"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  pathname: "/c",
  client: vi.fn(),
}))

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }))
vi.mock("@/components/community/billing/billing-plan.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("./community-layout-client", () => ({
  CommunityLayoutClient: (props: {
    currentUser: CurrentUser | null
    children: ReactNode
    sidebar: ReactNode
  }) => {
    mocks.client(props)
    return createElement("section", { "data-testid": "resolved-session" },
      props.currentUser?.id ?? "anonymous", props.sidebar, props.children)
  },
}))

import CommunityLayout from "./layout"

const children = createElement("main", { "data-testid": "private-child" }, "private content")
const sidebar = createElement("aside", { "data-testid": "private-sidebar" }, "private sidebar")
const session = {
  user: { id: "account-a", name: "Ada", email: "ada@example.com", image: "avatar-a" },
}

function renderLayout() {
  const output = new PassThrough()
  const errors: unknown[] = []
  let html = ""
  let resolvePublicFrame!: (html: string) => void
  const publicFrame = new Promise<string>((resolve) => { resolvePublicFrame = resolve })
  const finished = new Promise<string>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => {
      html += chunk.toString()
      if (html.includes("<!--/$-->")) resolvePublicFrame(html)
    })
    output.on("end", () => resolve(html))
    output.on("error", reject)
  })
  const rendering = renderToPipeableStream(createElement("html", null,
    createElement("body", null, createElement(CommunityLayout, { sidebar }, children))), {
    onShellReady: () => rendering.pipe(output),
    onShellError: (error) => output.destroy(error),
    onError: (error) => { errors.push(error) },
  })
  return { publicFrame, finished, errors, abort: rendering.abort }
}

describe("CommunityLayout server session streaming", () => {
  beforeEach(() => {
    mocks.getSession.mockReset()
    mocks.client.mockClear()
    mocks.pathname = "/c"
  })

  it.each([
    ["/c", "community-root-redirect", "route-resolution"],
    ["/c/channels/server-a/channel-a", "server-detail", "server-conversation"],
    ["/c/invite/token", "public-invite", null],
    ["/c/invite/token/extra", "unknown", "route-resolution"],
  ])("streams a public frame for %s while the session is held", async (pathname, route, main) => {
    mocks.pathname = pathname
    let release!: (value: typeof session) => void
    mocks.getSession.mockReturnValue(new Promise<typeof session>((resolve) => { release = resolve }))
    const rendering = renderLayout()
    try {
      const first = await rendering.publicFrame
      expect(first).toContain('data-testid="community-initial-frame"')
      expect(first).toContain(`data-community-route-kind="${route}"`)
      if (main) expect(first).toContain(`data-testid="community-pending-main-${main}"`)
      expect(first).not.toContain("private-child")
      expect(first).not.toContain("private-sidebar")
      expect(first).not.toContain("resolved-session")
      expect(first).not.toContain("account-a")
      expect(first).not.toContain("ada@example.com")
      expect(first).not.toContain("community-user-bar-name")
      expect(mocks.client).not.toHaveBeenCalled()
      expect(mocks.getSession).toHaveBeenCalledTimes(1)
      release(session)
      const complete = await rendering.finished
      expect(complete).toContain("resolved-session")
      expect(complete).toContain("private-child")
      expect(complete).toContain("private-sidebar")
      expect(mocks.client).toHaveBeenCalledTimes(1)
      expect(mocks.client).toHaveBeenCalledWith({
        currentUser: { id: "account-a", name: "Ada", email: "ada@example.com", avatar: "avatar-a", avatarVersion: 0 },
        children,
        sidebar,
      })
      expect(rendering.errors).toEqual([])
    } finally {
      rendering.abort()
    }
  })

  it.each([
    ["avatar-a", "avatar-a"],
    ["", "A"],
    [null, "A"],
  ])("preserves server user mapping for image %s", async (image, avatar) => {
    mocks.getSession.mockResolvedValue({ user: { ...session.user, image } })
    const rendering = renderLayout()
    await rendering.finished
    expect(mocks.client).toHaveBeenCalledWith({
      currentUser: { id: "account-a", name: "Ada", email: "ada@example.com", avatar, avatarVersion: 0 },
      children,
      sidebar,
    })
    expect(rendering.errors).toEqual([])
  })

  it("passes only a resolved null session to the original anonymous owner", async () => {
    mocks.getSession.mockResolvedValue(null)
    const rendering = renderLayout()
    await rendering.finished
    expect(mocks.client).toHaveBeenCalledWith({ currentUser: null, children, sidebar })
    expect(rendering.errors).toEqual([])
  })

  it("reports a rejected session without invoking an anonymous client branch", async () => {
    const error = new Error("session unavailable")
    mocks.getSession.mockRejectedValue(error)
    const rendering = renderLayout()
    await rendering.finished
    expect(rendering.errors).toContain(error)
    expect(mocks.client).not.toHaveBeenCalled()
  })
})
