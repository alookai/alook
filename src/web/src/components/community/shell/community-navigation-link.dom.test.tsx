import { createStore } from "@tanstack/react-store"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, setupUser } from "@/test/react-dom-harness"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityNavigationLink } from "./community-navigation-link"

const owner = vi.hoisted(() => ({ registry: null as CommunityDbRegistry | null }))
vi.mock("@/lib/community-db/projections", () => ({ useOptionalCommunityDbRegistry: () => owner.registry }))
vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))

beforeEach(() => { owner.registry = null })

describe("community public Link bridge", () => {
  it("requests full prefetch only on intent and resets it when href changes, retaining the anchor", async () => {
    const onActivate = vi.fn()
    const props = { href: "/c/channels/a/one", onActivate }
    const view = render(<CommunityNavigationLink {...props}>A</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    expect(anchor).toHaveAttribute("data-prefetch", "false")
    fireEvent.pointerEnter(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "true")
    expect(onActivate).not.toHaveBeenCalled()
    view.rerender(<CommunityNavigationLink {...props} href="/c/channels/a/two">A</CommunityNavigationLink>)
    expect(view.getByRole("link")).toBe(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "false")
    view.rerender(<CommunityNavigationLink {...props}>A</CommunityNavigationLink>)
    expect(anchor).toHaveAttribute("data-prefetch", "false")
    fireEvent.focus(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "true")
    await setupUser().click(anchor)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("warms a touch intent without navigating before activation", () => {
    const onActivate = vi.fn()
    const view = render(<CommunityNavigationLink href="/c/me/dm" onActivate={onActivate}>DM</CommunityNavigationLink>)
    const event = new Event("pointerdown", { bubbles: true })
    Object.defineProperty(event, "pointerType", { value: "touch" })
    fireEvent(view.getByRole("link"), event)
    expect(view.getByRole("link")).toHaveAttribute("data-prefetch", "true")
    expect(onActivate).not.toHaveBeenCalled()
  })

  it("warms visible fixed entries while inactive and preserves click and Enter actions", async () => {
    const onActivate = vi.fn()
    const props = { href: "/c/me/bots", onActivate, prefetchMode: "visible" as const }
    const view = render(<CommunityNavigationLink {...props}>Bots</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    expect(anchor).toHaveAttribute("data-prefetch", "true")
    view.rerender(<CommunityNavigationLink {...props} active>Bots</CommunityNavigationLink>)
    expect(anchor).toHaveAttribute("data-prefetch", "false")
    const user = setupUser()
    await user.click(anchor)
    anchor.focus()
    await user.keyboard("{Enter}")
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it("leaves modified activation outside the same-tab controller and respects captured suppression", () => {
    const onActivate = vi.fn()
    const view = render(<div onClickCapture={(event) => { if (event.altKey) event.preventDefault() }}>
      <CommunityNavigationLink href="/c/me/friends" onActivate={onActivate}>Friends</CommunityNavigationLink>
    </div>)
    const anchor = view.getByRole("link")
    fireEvent.click(anchor, { ctrlKey: true })
    fireEvent.click(anchor, { metaKey: true })
    fireEvent.click(anchor, { altKey: true })
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.click(anchor)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("blocks navigation and warming during dragging, then retires intent on account generation changes", () => {
    const lifecycle = createStore({ active: true, generation: 0 })
    owner.registry = { runtime: { lifecycle } } as unknown as CommunityDbRegistry
    const onActivate = vi.fn()
    const props = { href: "/c/channels/a/one", onActivate }
    const view = render(<CommunityNavigationLink {...props} navigationDisabled>A</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    fireEvent.pointerEnter(anchor)
    fireEvent.click(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "false")
    expect(onActivate).not.toHaveBeenCalled()
    view.rerender(<CommunityNavigationLink {...props}>A</CommunityNavigationLink>)
    fireEvent.focus(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "true")
    act(() => lifecycle.setState(() => ({ active: false, generation: 1 })))
    fireEvent.click(anchor)
    expect(anchor).toHaveAttribute("data-prefetch", "false")
    expect(onActivate).not.toHaveBeenCalled()
    act(() => lifecycle.setState(() => ({ active: true, generation: 2 })))
    expect(anchor).toHaveAttribute("data-prefetch", "false")
  })
})
