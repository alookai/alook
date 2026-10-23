import { createStore } from "@tanstack/react-store"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, setupUser } from "@/test/react-dom-harness"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityNavigationLink } from "./community-navigation-link"

const owner = vi.hoisted(() => ({ registry: null as CommunityDbRegistry | null, warm: vi.fn() }))
vi.mock("@/lib/community-db/projections", () => ({ useOptionalCommunityDbRegistry: () => owner.registry }))
vi.mock("@/lib/observability/context", () => ({ beginNavigationPrefetch: owner.warm }))
vi.mock("@/lib/community/navigation-metadata", () => ({ prepareNavigationMetadata: vi.fn() }))

beforeEach(() => { owner.registry = null; owner.warm.mockClear() })

describe("community public Link bridge", () => {
  it.each(["", "saved.html", true])("preserves native download activation for download=%s", download => {
    const onActivate = vi.fn()
    const view = render(<CommunityNavigationLink href="/c/me/friends" download={download} onActivate={onActivate}>Download</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    expect(anchor).toHaveAttribute("download")
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    fireEvent(anchor, click)
    expect(onActivate).not.toHaveBeenCalled()
    expect(click.defaultPrevented).toBe(false)
  })
  it("warms only client metadata on intent while retaining the anchor", async () => {
    const onActivate = vi.fn()
    const props = { href: "/c/channels/a/one", onActivate }
    const view = render(<CommunityNavigationLink {...props}>A</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    expect(owner.warm).not.toHaveBeenCalled()
    fireEvent.pointerEnter(anchor)
    expect(owner.warm).toHaveBeenLastCalledWith(props.href)
    expect(onActivate).not.toHaveBeenCalled()
    view.rerender(<CommunityNavigationLink {...props} href="/c/channels/a/two">A</CommunityNavigationLink>)
    expect(view.getByRole("link")).toBe(anchor)
    expect(owner.warm).toHaveBeenCalledTimes(1)
    view.rerender(<CommunityNavigationLink {...props}>A</CommunityNavigationLink>)
    expect(owner.warm).toHaveBeenCalledTimes(1)
    fireEvent.focus(anchor)
    expect(owner.warm).toHaveBeenCalledTimes(1)
    await setupUser().click(anchor)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("warms a touch intent without navigating before activation", () => {
    const onActivate = vi.fn()
    const view = render(<CommunityNavigationLink href="/c/me/dm" onActivate={onActivate}>DM</CommunityNavigationLink>)
    const event = new Event("pointerdown", { bubbles: true })
    Object.defineProperty(event, "pointerType", { value: "touch" })
    fireEvent(view.getByRole("link"), event)
    expect(owner.warm).toHaveBeenCalledWith("/c/me/dm")
    expect(onActivate).not.toHaveBeenCalled()
  })

  it("warms visible fixed entries while inactive and preserves click and Enter actions", async () => {
    const onActivate = vi.fn()
    const props = { href: "/c/me/bots", onActivate, prefetchMode: "visible" as const }
    const view = render(<CommunityNavigationLink {...props}>Bots</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    expect(owner.warm).toHaveBeenCalledWith(props.href)
    view.rerender(<CommunityNavigationLink {...props} active>Bots</CommunityNavigationLink>)
    expect(owner.warm).toHaveBeenCalledTimes(1)
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

  it("blocks navigation and warming during dragging, then blocks a retired account generation", () => {
    const lifecycle = createStore({ active: true, generation: 0 })
    owner.registry = { runtime: { lifecycle } } as unknown as CommunityDbRegistry
    const onActivate = vi.fn()
    const props = { href: "/c/channels/a/one", onActivate }
    const view = render(<CommunityNavigationLink {...props} navigationDisabled>A</CommunityNavigationLink>)
    const anchor = view.getByRole("link")
    fireEvent.pointerEnter(anchor)
    fireEvent.click(anchor)
    expect(owner.warm).not.toHaveBeenCalled()
    expect(onActivate).not.toHaveBeenCalled()
    view.rerender(<CommunityNavigationLink {...props}>A</CommunityNavigationLink>)
    fireEvent.focus(anchor)
    expect(owner.warm).toHaveBeenCalledOnce()
    act(() => lifecycle.setState(() => ({ active: false, generation: 1 })))
    fireEvent.click(anchor)
    expect(owner.warm).toHaveBeenCalledOnce()
    expect(onActivate).not.toHaveBeenCalled()
    act(() => lifecycle.setState(() => ({ active: true, generation: 2 })))
    expect(owner.warm).toHaveBeenCalledOnce()
  })
})

import { CommunityPreviewNavigation } from "./community-preview-navigation"

it("keeps preview links local without prefetching real account routes", async () => {
  const onActivate = vi.fn()
  const view = render(<CommunityPreviewNavigation value={true}>
    <CommunityNavigationLink href="/c/me/friends" prefetchMode="visible" onActivate={onActivate}>Friends</CommunityNavigationLink>
  </CommunityPreviewNavigation>)
  const anchor = view.getByRole("link")
  expect(anchor).toHaveAttribute("href", "#product")
  fireEvent.pointerEnter(anchor)
  fireEvent.focus(anchor)
  expect(owner.warm).not.toHaveBeenCalled()
  await setupUser().click(anchor)
  expect(onActivate).toHaveBeenCalledOnce()
})
