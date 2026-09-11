import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import type { Profile } from "@/components/community/social/profile-types"

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

vi.mock("./bot-mark-sticker", () => ({
  BotMarkSticker: () => React.createElement("bot-mark-sticker"),
}))

import { ProfileCard } from "./profile-card"

const ownedBotIdentity: Profile["identity"] = {
  kind: "bot",
  ownerProfile: { id: "owner_1", handle: "Owner#0042" },
  ownedByViewer: true,
}

function surfaceElement(
  queryClient: QueryClient,
  bp: "mobile" | "desktop",
  overrides: Partial<Profile> = {},
) {
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(ProfileCard, {
      data: {
        name: "Ren",
        userId: "user_1",
        avatar: "R",
        about: "Profile bio",
        mutual: 0,
        ...overrides,
      },
      x: 24,
      y: 48,
      bp,
      onClose: vi.fn(),
    }),
  )
}

function renderSurface(bp: "mobile" | "desktop", overrides: Partial<Profile> = {}) {
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
        ...overrides,
      },
      x: 24,
      y: 48,
      bp,
      onClose,
    }),
  ))
  return { renderer, onClose }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ProfileCard surface contracts", () => {
  it("reuses profile content without an overlay shell inside the User Bar extension", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ProfileCard, {
        data: { name: "Ren", userId: "user_1", mutual: 0 },
        x: 0,
        y: 0,
        bp: "mobile",
        onClose: vi.fn(),
        extension: true,
      }),
    ))

    const profile = renderer.getByTestId("community-profile-card")
    expect(profile.className).toBe("w-full")
    expect(renderer.container.querySelectorAll("sheet-root")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("popover-root")).toHaveLength(0)
  })

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
    expect(content.className).toContain("overflow-visible")
    expect(content.className).not.toContain("data-[side=bottom]:border-t-0")
    expect(renderer.container.querySelectorAll("sheet-root")).toHaveLength(0)
    expect(renderer.getByTestId("community-profile-card")).toBeInTheDocument()
  })

  it("clips and disables the owned desktop preview before its first measurement", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(surfaceElement(queryClient, "desktop", {
      identity: ownedBotIdentity,
    }))

    expect(html).toContain("overflow-hidden")
    expect(html).toContain('data-measurement-ready="false"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("visibility:hidden")
    expect(html).toContain("pointer-events:none")
    expect(html).not.toContain('data-placement="right"')
  })

  it("requires a fresh measurement for each target and remount", async () => {
    const readinessWrites: string[] = []
    const setAttribute = Element.prototype.setAttribute
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (name, value) {
      if (name === "data-measurement-ready") readinessWrites.push(value)
      setAttribute.call(this, name, value)
    })
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function () {
      return this.getAttribute("data-testid") === "community-profile-card" ? 300 : 260
    })
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      return this.getAttribute("data-testid") === "community-profile-card" ? 280 : 220
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const left = this.getAttribute("data-testid") === "community-profile-card" ? 24 : 0
      const top = this.getAttribute("data-testid") === "community-profile-card" ? 48 : 0
      const width = 300
      const height = this.getAttribute("data-testid") === "community-profile-card" ? 280 : 220
      return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({}),
      }
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renderer = render(surfaceElement(queryClient, "desktop", {
      identity: ownedBotIdentity,
    }))
    const dock = renderer.getByTestId("community-bot-audit-preview-dock")
    await waitFor(() => expect(dock).toHaveAttribute("data-measurement-ready", "true"))
    expect(readinessWrites.slice(0, 2)).toEqual(["false", "true"])
    expect(dock).toHaveAttribute("aria-hidden", "false")
    expect(dock).toHaveStyle({ visibility: "visible" })
    expect(mockProps.get("popover-content")?.className).toContain("overflow-visible")

    readinessWrites.length = 0
    renderer.rerender(surfaceElement(queryClient, "desktop", {
      userId: "user_2",
      identity: ownedBotIdentity,
    }))
    await waitFor(() => expect(readinessWrites).toContain("true"))
    expect(readinessWrites[0]).toBe("false")
    expect(readinessWrites.indexOf("false")).toBeLessThan(readinessWrites.indexOf("true"))

    renderer.rerender(surfaceElement(queryClient, "mobile", {
      userId: "user_2",
      identity: ownedBotIdentity,
    }))
    expect(renderer.queryByTestId("community-bot-audit-preview-dock")).toBeNull()
    readinessWrites.length = 0
    renderer.rerender(surfaceElement(queryClient, "desktop", {
      userId: "user_2",
      identity: ownedBotIdentity,
    }))
    await waitFor(() => expect(readinessWrites).toContain("true"))
    expect(readinessWrites[0]).toBe("false")
    expect(readinessWrites.indexOf("false")).toBeLessThan(readinessWrites.indexOf("true"))

    renderer.unmount()
    readinessWrites.length = 0
    const remounted = render(surfaceElement(queryClient, "desktop", {
      userId: "user_2",
      identity: ownedBotIdentity,
    }))
    await waitFor(() => expect(readinessWrites).toContain("true"))
    expect(readinessWrites[0]).toBe("false")
    expect(readinessWrites.indexOf("false")).toBeLessThan(readinessWrites.indexOf("true"))
    remounted.unmount()
  })
})
