import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { readFileSync } from "node:fs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/sheet", () => {
  const pass = (type: string) =>
    function Passthrough({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
      return React.createElement(type, props, children)
    }
  return {
    Sheet: pass("sheet-root"),
    SheetClose: pass("sheet-close"),
    SheetContent: pass("sheet-content"),
    SheetTitle: pass("sheet-title"),
  }
})

vi.mock("@/components/ui/popover", () => {
  const pass = (type: string) =>
    function Passthrough({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
      return React.createElement(type, props, children)
    }
  return {
    Popover: pass("popover-root"),
    PopoverTrigger: pass("popover-trigger"),
    PopoverContent: pass("popover-content"),
  }
})

vi.mock("../avatar", () => ({
  Avatar: () => React.createElement("avatar"),
}))

vi.mock("@/components/avatar", () => ({
  SeededBackdrop: () => React.createElement("seeded-backdrop"),
}))

import { ProfileCard } from "./profile-card"

function renderSurface(bp: "mobile" | "desktop") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const onClose = vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ProfileCard, {
          data: {
            name: "Ren",
            userId: "user_1",
            avatar: "R",
            about: "Profile bio",
            mutual: 0,
          },
          x: 24,
          y: 48,
          bp,
          onClose,
        }),
      ),
    )
  })
  return { renderer, onClose }
}

describe("ProfileCard surface contracts", () => {
  it("uses the shared modal bottom Sheet without a copied or foreground-derived overlay", () => {
    const { renderer } = renderSurface("mobile")
    const root = renderer.root.findByType("sheet-root")
    const close = renderer.root.findByType("sheet-close")
    const content = renderer.root.findByType("sheet-content")
    const profile = renderer.root.findByProps({ "data-testid": "community-profile-card" })

    expect(root.props.open).toBe(true)
    expect(root.props.modal).toBe(true)
    expect(close.props.className).toBe("sr-only")
    expect(close.children).toEqual(["Close profile"])
    expect(content.props.side).toBe("bottom")
    expect(content.props.showOverlay).toBe(true)
    expect(content.props.showCloseButton).toBe(false)
    expect(content.props.className).toContain("bg-transparent")
    expect(content.props.className).toContain("data-[side=bottom]:border-t-0")
    expect(content.props.className).not.toContain("bg-foreground")
    expect(profile.props.className).toContain("bg-popover")
    expect(renderer.root.findAllByType("popover-root")).toHaveLength(0)

    const profileSource = readFileSync(new URL("./profile-card.tsx", import.meta.url), "utf8")
    const sheetSource = readFileSync(new URL("../../ui/sheet.tsx", import.meta.url), "utf8")
    expect(profileSource).not.toContain("bg-foreground/30")
    expect(profileSource).not.toContain("<SheetOverlay")
    expect(sheetSource).toContain("bg-black/20")
    expect(sheetSource).not.toContain("bg-foreground")
  })

  it.each([
    ["outside press", { reason: "outside-press" }],
    ["Escape", { reason: "escape-key" }],
  ])("routes %s dismissal through the shared Sheet callback", (_label, details) => {
    const { renderer, onClose } = renderSurface("mobile")
    const root = renderer.root.findByType("sheet-root")

    act(() => root.props.onOpenChange(false, details))

    expect(onClose).toHaveBeenCalledOnce()
    expect(renderer.root.findByType("sheet-root").props.open).toBe(false)
  })

  it("keeps the desktop profile on the anchored Popover path", () => {
    const { renderer } = renderSurface("desktop")
    const root = renderer.root.findByType("popover-root")
    const trigger = renderer.root.findByType("popover-trigger")
    const content = renderer.root.findByType("popover-content")

    expect(root.props.open).toBe(true)
    expect(trigger.props.style).toEqual({ left: 24, top: 48 })
    expect(content.props.side).toBe("right")
    expect(content.props.className).toContain("w-75")
    expect(renderer.root.findAllByType("sheet-root")).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": "community-profile-card" })).toBeTruthy()
  })
})
