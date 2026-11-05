import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor, within } from "@/test/react-dom-harness"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { tid } from "@/lib/community/testids"
import { CaptureSurface } from "../../../app-store-capture/captures/surface"
import { Artwork } from "../../../app-store-capture/captures/poster"

const owned = vi.hoisted(() => ({ registries: [] as CommunityDbRegistry[] }))
vi.mock("@/lib/community-db/collections", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/community-db/collections")>()
  return { ...original, createCommunityDbRegistry: (...args: Parameters<typeof original.createCommunityDbRegistry>) => {
    const registry = original.createCommunityDbRegistry(...args)
    owned.registries.push(registry)
    return registry
  } }
})

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
beforeEach(() => {
  owned.registries.length = 0
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === tid.messageScroller ? 800 : 0
  })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === tid.messageScroller ? 1280 : 0
  })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === tid.messageScroller ? 800 : 0
  })
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === tid.messageScroller ? 1280 : 0
  })
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    if (options.top !== undefined) this.scrollTop = options.top
    if (options.left !== undefined) this.scrollLeft = options.left
  } })
})
afterEach(async () => {
  try {
    await act(async () => {
      await vi.dynamicImportSettled()
      for (const registry of owned.registries) {
        await registry.cleanup()
        registry.queryClient.clear()
      }
    })
  } finally {
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo)
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
})

describe("component-rendered App Store artwork", () => {
  it("renders shared Web components with the homepage fixtures and isolated iframe viewports", async () => {
    const view = render(<CaptureSurface scene="workspace" beat={9} />)
    try {
      await waitFor(() => expect(view.container.querySelector("main[data-capture-surface]")).toHaveAttribute("data-capture-ready", "true"))
      expect(view.getByRole("button", { name: "general" })).toBeInTheDocument()
      expect(await view.findByTestId(tid.message("general-2"))).toHaveTextContent("Let visitors open a room, read what the team is doing, and ask a question in the composer.")
      expect(view.getByTestId(tid.composerInput).querySelector('[contenteditable="true"]')).not.toBeNull()

      for (const [scene, beat, text] of [
        ["reply", 9, "Keep the existing product story below it."],
        ["continuity-ask", 9, "Have you checked the updated page on your phone?"],
        ["continuity-answer", 9, "The button text still needs an update."],
      ] as const) {
        view.rerender(<CaptureSurface scene={scene} beat={beat} />)
        const bodies = view.container.querySelectorAll("[data-community-message-body]")
        expect(bodies).toHaveLength(1)
        expect(bodies[0]).toHaveTextContent(text)
      }

      view.rerender(<CaptureSurface scene="profile" beat={9} />)
      expect(view.getByText("Maya")).toBeInTheDocument()
      expect(view.getByText("I keep the same account, identity, and relationships across every room.")).toBeInTheDocument()
      expect(view.getByTestId(tid.profileContextBadge)).toHaveTextContent("Agent")
      expect(view.getByTestId(tid.statusPill)).toHaveTextContent("Free for dinner")
      expect(view.queryByPlaceholderText("Message @Maya")).toBeNull()

      view.rerender(<CaptureSurface scene="composer" beat={9} />)
      await waitFor(() => expect(view.getByTestId(tid.composerInput).querySelector('[contenteditable="true"]')).not.toBeNull())
      expect(view.getByTestId(tid.composerAttach)).toBeInTheDocument()

      for (const [scene, beat, text] of [
        ["identity", 12, "Maya"],
        ["continuity", 14, "Saturday at six works."],
        ["provider", 9, "Hi Gus — I’m running on Codex."],
      ] as const) {
        view.rerender(<CaptureSurface scene={scene} beat={beat} />)
        const surface = view.container.querySelector<HTMLElement>("main[data-capture-surface]")!
        expect(surface).toHaveAttribute("data-capture-surface", scene)
        expect((await within(surface).findAllByText(text, { exact: false })).length).toBeGreaterThan(0)
      }

      const scenes = new Set<string>()
      for (const [kind, large, width, height] of [
        ["phone", false, 1206, 2622], ["phone", true, 1320, 2868],
        ["tablet", false, 2752, 2064], ["duo", false, 2007, 2853],
      ] as const) {
        for (let story = 1; story <= 6; story += 1) {
          const poster = new DOMParser().parseFromString(renderToStaticMarkup(<Artwork kind={kind} large={large} story={story} />), "text/html")
          try {
            expect(poster.defaultView).toBeNull()
            const canvas = poster.getElementById("capture-poster")!
            expect([canvas.style.width, canvas.style.height]).toEqual([`${width}px`, `${height}px`])
            const frames = [...canvas.querySelectorAll("iframe")]
            expect(frames.length).toBeGreaterThan(0)
            for (const frame of frames) {
              const url = new URL(frame.getAttribute("src")!, "http://capture.test/")
              expect(url.origin).toBe("http://capture.test")
              expect(url.pathname).toBe("/surface")
              const scene = url.searchParams.get("scene")!
              scenes.add(scene)
              expect(frame.title).toBe(`Alook ${scene}`)
              expect(Number(url.searchParams.get("beat"))).toBeGreaterThanOrEqual(0)
              expect([frame.width, frame.height]).toEqual([frame.dataset.logicalWidth, frame.dataset.logicalHeight])
              expect(Number(frame.width)).toBeGreaterThan(0)
              expect(Number(frame.height)).toBeGreaterThan(0)
            }
            if (kind === "duo" && story === 6) expect(frames.map(frame => [frame.width, frame.height])).toEqual([["951", "669"], ["466", "678"]])
          } finally { poster.replaceChildren() }
        }
      }
      expect(scenes).toEqual(new Set(["workspace", "reply", "identity", "profile", "continuity", "continuity-ask", "continuity-answer", "composer", "provider"]))
    } finally {
      view.rerender(<></>)
      await act(async () => { await vi.dynamicImportSettled() })
    }
  })
})
