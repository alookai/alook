import { StrictMode } from "react"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { DEMO_MESSAGES } from "@/components/home/landing-interactive-shell-data"
import { CONTINUITY_WORK_MESSAGES } from "@/components/home/landing-shell-motion"
import SurfacePage from "./app/surface/page"
import { CaptureSurface } from "./captures/surface"

const observed = vi.hoisted(() => ({ registries: [] as CommunityDbRegistry[] }))

const surfaceQueries: [Record<string, string | string[] | undefined>, string, number][] = [
  [{}, "workspace", 9],
  [{ scene: ["profile"], beat: "3" }, "workspace", 3],
  [{ scene: "identity", beat: "14" }, "identity", 14],
  [{ scene: "unknown", beat: "invalid" }, "unknown", Number.NaN],
]

vi.mock("@/lib/community-db/collections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/community-db/collections")>()
  return {
    ...original,
    createCommunityDbRegistry: (...args: Parameters<typeof original.createCommunityDbRegistry>) => {
      const registry = original.createCommunityDbRegistry(...args)
      observed.registries.push(registry)
      return registry
    },
  }
})

beforeEach(() => {
  observed.registries.length = 0
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
})

afterEach(async () => {
  cleanup()
  await act(async () => { await Promise.resolve() })
  for (const registry of observed.registries) {
    await registry.cleanup()
    registry.queryClient.clear()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("App Store capture shared surfaces", () => {
  it("mounts the real workspace and changes channels through its existing control", async () => {
    const view = render(<CaptureSurface scene="workspace" beat={9} />)
    expect(view.container.querySelector("main")).toHaveAttribute("data-capture-ready", "true")
    expect(await screen.findByRole("button", { name: "general" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "design-review" }))
    await waitFor(() => expect(view.container.querySelector('[data-placeholder="Message /design-review"]')).not.toBeNull())
    view.unmount()
  })

  it.each([
    ["reply", DEMO_MESSAGES["demo-general"].find(message => message.authorId === "demo-alli")!.content!, "Alli"],
    ["continuity-ask", CONTINUITY_WORK_MESSAGES[0].content!, "Alli"],
    ["continuity-answer", CONTINUITY_WORK_MESSAGES[1].content!, "Shelly"],
  ])("renders %s from canonical homepage messages with their own author", async (scene, content, author) => {
    const view = render(<CaptureSurface scene={scene} beat={9} />)
    const row = view.container.querySelector("[data-page-swipe-reply-row]")
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain(content.replace(/#\d{4,}\b/g, ""))
    expect(row?.textContent).toContain(author)
    view.unmount()
  })

  it("renders the real profile and composer without a live account", async () => {
    const profile = render(<CaptureSurface scene="profile" beat={9} />)
    expect(await screen.findByText("Free for dinner")).toBeInTheDocument()
    expect(profile.container.textContent).toContain("Maya")
    profile.unmount()
    const composer = render(<CaptureSurface scene="composer" beat={9} />)
    await waitFor(() => expect(composer.container.querySelector('[data-placeholder="Message /general"]')).not.toBeNull())
    composer.unmount()
  })

  it.each(["identity", "continuity", "provider"])("renders the actual %s motion scene at the requested beat", (scene) => {
    const view = render(<CaptureSurface scene={scene} beat={9} />)
    expect(view.container.querySelector('[data-testid="landing-motion-stage"]')).not.toBeNull()
    expect(view.container.textContent).not.toContain("Unknown")
    expect(view.container.textContent?.length).toBeGreaterThan(50)
    view.unmount()
  })

  it("keeps fixture owners live through effect replay and retires them on unmount", async () => {
    const view = render(<StrictMode><CaptureSurface scene="reply" beat={9} /></StrictMode>)
    await act(async () => { await Promise.resolve() })
    const active = observed.registries.filter(registry => registry.runtime.lifecycle.get().active)
    expect(active.length).toBeGreaterThan(0)
    view.rerender(<StrictMode><CaptureSurface scene="continuity-answer" beat={9} /></StrictMode>)
    expect(view.container.textContent).toContain("Shelly")
    expect(active.every(registry => registry.runtime.lifecycle.get().active)).toBe(true)
    view.unmount()
    await waitFor(() => expect(observed.registries.every(registry => !registry.runtime.lifecycle.get().active)).toBe(true))
    expect(observed.registries.every(registry => registry.queryClient.getQueryCache().getAll().length === 0)).toBe(true)
  })

  it.each(surfaceQueries)("resolves surface query %j without replacing its scene or beat", async (query, scene, beat) => {
    const element = await SurfacePage({ searchParams: Promise.resolve(query) })
    expect(element.type).toBe(CaptureSurface)
    expect(element.props).toEqual({ scene, beat })
    if (scene === "unknown") {
      const view = render(element)
      expect(view.container.querySelector("main")?.children).toHaveLength(1)
      expect(view.container.querySelector("main")?.firstElementChild?.tagName).toBe("STYLE")
      view.unmount()
    }
  })
})
