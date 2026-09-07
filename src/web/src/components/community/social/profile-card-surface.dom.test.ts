import React from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const mockProps = vi.hoisted(() => new Map<string, Record<string, unknown>>())

vi.mock("@/components/ui/sheet", () => {
  const pass = (type: string) =>
    function Passthrough({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
      mockProps.set(type, props)
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
      mockProps.set(type, props)
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
  mockProps.clear()
  const renderer = render(React.createElement(
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
  ))
  return { renderer, onClose }
}

describe("ProfileCard surface contracts", () => {
  it("uses the shared modal bottom Sheet without a copied or foreground-derived overlay", () => {
    const { renderer } = renderSurface("mobile")
    const root = mockProps.get("sheet-root")!
    const close = renderer.container.querySelector("sheet-close")!
    const content = mockProps.get("sheet-content")!
    const profile = renderer.getByTestId("community-profile-card")

    expect(root.open).toBe(true)
    expect(root.modal).toBe(true)
    expect(close).toHaveClass("sr-only")
    expect(close).toHaveTextContent("Close profile")
    expect(content.side).toBe("bottom")
    expect(content.showOverlay).toBe(true)
    expect(content.showCloseButton).toBe(false)
    expect(content.className).toContain("data-[side=bottom]:border-t-0")
    expect(content.className).not.toContain("border-0")
    expect(content.className).toContain("bg-transparent")
    expect(content.className).not.toContain("bg-foreground")
    expect(profile.className).toContain("rounded-xl")
    expect(profile.className).toContain("border")
    expect(profile.className).toContain("border-border")
    expect(profile.className).toContain("bg-popover")
    expect(renderer.container.querySelectorAll("popover-root")).toHaveLength(0)

    const profileSource = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/community/social/profile-card.tsx",
    ), "utf8")
    const sheetSource = readFileSync(resolve(
      process.cwd(),
      process.cwd().endsWith("/src/web") ? "" : "src/web",
      "src/components/ui/sheet.tsx",
    ), "utf8")
    expect(profileSource).not.toContain("bg-foreground/30")
    expect(profileSource).not.toContain("<SheetOverlay")
    expect(sheetSource).toContain("data-[side=bottom]:border-t")
    expect(sheetSource).toContain("bg-black/20")
    expect(sheetSource).not.toContain("bg-foreground")
  })

  it.each([
    ["outside press", { reason: "outside-press" }],
    ["Escape", { reason: "escape-key" }],
  ])("routes %s dismissal through the shared Sheet callback", (_label, details) => {
    const { renderer, onClose } = renderSurface("mobile")
    const root = mockProps.get("sheet-root")!

    act(() => (root.onOpenChange as (open: boolean, details: unknown) => void)(false, details))

    expect(onClose).toHaveBeenCalledOnce()
    expect(mockProps.get("sheet-root")?.open).toBe(false)
  })

  it("keeps the desktop profile on the anchored Popover path", () => {
    const { renderer } = renderSurface("desktop")
    const root = mockProps.get("popover-root")!
    const trigger = mockProps.get("popover-trigger")!
    const content = mockProps.get("popover-content")!

    expect(root.open).toBe(true)
    expect(trigger.style).toEqual({ left: 24, top: 48 })
    expect(content.side).toBe("right")
    expect(content.className).toContain("w-75")
    expect(content.className).not.toContain("data-[side=bottom]:border-t-0")
    expect(renderer.container.querySelectorAll("sheet-root")).toHaveLength(0)
    expect(renderer.getByTestId("community-profile-card")).toBeInTheDocument()
  })
})
