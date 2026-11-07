import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
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
  Avatar: () => React.createElement("mock-avatar"),
}))

vi.mock("@/components/avatar", () => ({
  SeededBackdrop: () => React.createElement("seeded-backdrop"),
}))

vi.mock("./bot-mark-sticker", () => ({
  BotMarkSticker: () => React.createElement("bot-mark-sticker"),
}))

vi.mock("./profile-running-bots-card", () => ({
  ProfileRunningBotsCard: () => React.createElement(
    "section",
    { "data-testid": "community-profile-running-bots-card" },
  ),
}))

vi.mock("@/hooks/community/use-running-owned-bots", () => ({
  useRunningOwnedBots: () => ({
    runningBots: [{ id: "working-bot" }],
    initialLoading: false,
    unavailable: false,
  }),
}))

vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => ({ bots: [{ id: "user_1", runtime: "claude" }] }),
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
    expect(profile).toHaveTextContent("Ren")
    expect(renderer.container.querySelectorAll("sheet-root")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("popover-root")).toHaveLength(0)
  })

  it("renders the self extension without the running-bots zone or an overlay", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const renderer = render(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ProfileCard, {
        data: { name: "Ren", userId: "user_1", mutual: 0 },
        x: 0,
        y: 0,
        bp: "desktop",
        onClose: vi.fn(),
        isSelf: true,
        extension: true,
      }),
    ))

    const profile = renderer.getByTestId("community-profile-card")
    expect(profile).toHaveTextContent("Ren")
    expect(renderer.getAllByTestId("community-profile-card")).toHaveLength(1)
    expect(renderer.queryByTestId("community-profile-running-bots-card")).toBeNull()
    expect(renderer.container.querySelectorAll("sheet-root")).toHaveLength(0)
    renderer.unmount()
  })

  it("configures a modal bottom Sheet and mounts its overlay with hidden edge decorations", async () => {
    const { renderer } = renderSurface("mobile")
    const root = mockProps.get("sheet-root")!
    const close = renderer.container.querySelector("sheet-close")!
    const content = mockProps.get("sheet-content")!
    const profile = renderer.getByTestId("community-profile-card")

    expect(root.open).toBe(true)
    expect(root.modal).toBe(true)
    expect(close).toHaveTextContent("Close profile")
    expect(content.side).toBe("bottom")
    expect(content.showOverlay).toBe(true)
    expect(content.showCloseButton).toBe(false)
    expect(profile).toHaveTextContent("Ren")
    expect(renderer.container.querySelectorAll("popover-root")).toHaveLength(0)

    const sharedSheet = await vi.importActual<typeof import("@/components/ui/sheet")>("@/components/ui/sheet")
    render(React.createElement(
      sharedSheet.Sheet,
      { defaultOpen: true },
      React.createElement(
        sharedSheet.SheetContent,
        { showCloseButton: false },
        React.createElement(sharedSheet.SheetTitle, null, "Shared profile backdrop"),
      ),
    ))
    const overlay = document.querySelector('[data-slot="sheet-overlay"]')
    expect(overlay).toBeInTheDocument()
    const fades = overlay!.querySelector('[data-slot="app-edge-fade"]')
    expect(fades).toBeInTheDocument()
    expect(fades).toHaveAttribute("aria-hidden", "true")
    expect(fades!.querySelectorAll("[data-app-edge]")).toHaveLength(4)
    for (const side of ["top", "bottom", "left", "right"]) {
      expect(fades!.querySelector(`[data-app-edge="${side}"]`)).toBeInTheDocument()
    }
  })

  it.each([
    ["outside press", { reason: "outside-press" }],
    ["Escape", { reason: "escape-key" }],
  ])("routes %s dismissal through the shared Sheet callback", (_label, details) => {
    const { renderer, onClose } = renderSurface("mobile")
    const root = mockProps.get("sheet-root")!

    act(() => (root.onOpenChange as (open: boolean, details: unknown) => void)(false, details))

    expect(onClose).not.toHaveBeenCalled()
    expect(mockProps.get("sheet-root")?.open).toBe(false)
    act(() => (mockProps.get("sheet-root")!.onOpenChangeComplete as (open: boolean) => void)(false))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("keeps the desktop profile on the anchored Popover path", () => {
    const { renderer } = renderSurface("desktop")
    const root = mockProps.get("popover-root")!
    const trigger = mockProps.get("popover-trigger")!
    const content = mockProps.get("popover-content")!

    expect(root.open).toBe(true)
    expect(trigger.style).toEqual({ left: 24, top: 48 })
    expect(content.side).toBe("right")
    expect(renderer.container.querySelectorAll("sheet-root")).toHaveLength(0)
    expect(renderer.getByTestId("community-profile-card")).toBeInTheDocument()
  })

  it("keeps the owned desktop preview hidden and inert before its first measurement", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const html = renderToStaticMarkup(surfaceElement(queryClient, "desktop", {
      identity: ownedBotIdentity,
    }))

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
