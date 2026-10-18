import { createElement, useLayoutEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import type { CommunityNavigationController } from "@/contexts/community/route-frame"
import { useMobileBackTransition } from "./use-mobile-back-transition"
import type { MobileBackGesture } from "@/lib/community/mobile-back-gesture"

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), addTransitionType: vi.fn() }))

describe("interactive page snapshot ownership", () => {
  let api: ReturnType<typeof useMobileBackTransition>
  let current: boolean
  let replace: ReturnType<typeof vi.fn>
  let animation: Animation
  let finished: ReturnType<typeof Promise.withResolvers<Animation>>
  let makeAnimation: ReturnType<typeof vi.fn>

  function Harness({ frameHref = "/c/me/dm1", pendingHref = null, attach = true }: {
    frameHref?: string; pendingHref?: string | null; attach?: boolean
  }) {
    const transition = useMobileBackTransition({ mobile: true, parentPath: "/c/me", frameHref,
      navigation: { navigationPending: Boolean(pendingHref), pendingHref, replace,
        captureIntent: () => () => current } as unknown as CommunityNavigationController })
    api = transition
    const { preview, attach: attachSnapshot } = transition
    useLayoutEffect(() => {
      if (preview && attach) return attachSnapshot({ name: "page" }, preview.id)
    }, [attachSnapshot, preview, attach])
    return createElement("input", { "aria-label": "Draft", defaultValue: "unfinished" })
  }

  beforeEach(() => {
    current = true
    replace = vi.fn()
    finished = Promise.withResolvers<Animation>()
    animation = { currentTime: 0, playbackRate: 1, finished: finished.promise,
      pause: vi.fn(), play: vi.fn(), cancel: vi.fn(), finish: vi.fn(() => finished.resolve(animation)),
    } as unknown as Animation
    makeAnimation = vi.fn(() => animation)
    vi.stubGlobal("CSS", { supports: () => true })
    vi.stubGlobal("matchMedia", () => ({ matches: false }))
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: vi.fn() })
    Object.defineProperty(document.documentElement, "animate", { configurable: true, value: makeAnimation })
  })

  afterEach(() => {
    delete (document as Partial<Document>).startViewTransition
    delete (document.documentElement as Partial<HTMLElement>).animate
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("seeks only the snapshot, then cancels without navigation or remounting the draft", async () => {
    render(createElement(Harness))
    const input = screen.getByRole("textbox")
    let gesture: MobileBackGesture | null = null
    await act(async () => { gesture = api.begin(); gesture?.update(.4) })
    expect(api.isActive()).toBe(true)
    expect(animation.pause).toHaveBeenCalledOnce()
    expect(animation.currentTime).toBe(80)
    expect(makeAnimation.mock.calls[0][1]).toMatchObject({ pseudoElement: "::view-transition-old(page)", duration: 200 })
    expect(replace).not.toHaveBeenCalled()
    act(() => { gesture!.cancel() })
    expect(animation.playbackRate).toBe(-1)
    await act(async () => { finished.resolve(animation) })
    expect(api.preview).toBeNull()
    expect(api.isActive()).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox")).toBe(input)
    expect(input).toHaveValue("unfinished")
  })

  it("commits once after release finishes, with no second automatic animation", async () => {
    const renderer = render(createElement(Harness))
    let gesture: MobileBackGesture | null = null
    await act(async () => { gesture = api.begin(); gesture?.update(.6) })
    replace.mockImplementation((href: string) => renderer.rerender(createElement(Harness, { pendingHref: href })))
    act(() => { gesture!.complete(); gesture!.complete() })
    expect(replace).not.toHaveBeenCalled()
    expect(animation.playbackRate).toBe(1)
    await act(async () => { finished.resolve(animation) })
    expect(replace).toHaveBeenCalledExactlyOnceWith("/c/me", { transitionTypes: [] })
    expect(api.preview).toMatchObject({ href: "/c/me", committing: true })
    await act(async () => { renderer.rerender(createElement(Harness, { frameHref: "/c/me" })) })
    expect(api.preview).toBeNull()
    expect(gesture!.complete()).toBe(false)
  })

  it("finishes an endpoint release instead of leaving the snapshot paused at its end", async () => {
    render(createElement(Harness))
    let gesture: MobileBackGesture | null = null
    await act(async () => { gesture = api.begin(); gesture?.update(1) })
    await act(async () => { gesture!.complete() })
    expect(animation.finish).toHaveBeenCalledOnce()
    expect(replace).toHaveBeenCalledOnce()
  })

  it("drops a release after another navigation owns the frame", async () => {
    render(createElement(Harness))
    let gesture: MobileBackGesture | null = null
    await act(async () => { gesture = api.begin(); gesture?.update(.6) })
    current = false
    act(() => { gesture!.complete() })
    await act(async () => { finished.resolve(animation) })
    expect(api.preview).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })

  it("retires a skipped snapshot and lets the input owner use ordinary Back", async () => {
    render(createElement(Harness, { attach: false }))
    let gesture: MobileBackGesture | null = null
    await act(async () => { gesture = api.begin() })
    expect(api.preview).toBeNull()
    expect(gesture!.complete()).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it("commits an already confirmed input when the snapshot is skipped", async () => {
    render(createElement(Harness, { attach: false }))
    await act(async () => { api.begin()?.complete() })
    expect(replace).toHaveBeenCalledExactlyOnceWith("/c/me", { transitionTypes: [] })
  })

  it("aborts and fences late animation completion on unmount", async () => {
    const renderer = render(createElement(Harness))
    let gesture: MobileBackGesture | null = null
    await act(async () => { gesture = api.begin() })
    renderer.unmount()
    await act(async () => { finished.resolve(animation) })
    expect(animation.cancel).toHaveBeenCalledOnce()
    expect(gesture!.complete()).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })

  it.each(["reduced motion", "missing snapshots", "missing classes"])("uses immediate Back with %s", (condition) => {
    if (condition === "reduced motion") vi.stubGlobal("matchMedia", () => ({ matches: true }))
    if (condition === "missing snapshots") delete (document as Partial<Document>).startViewTransition
    if (condition === "missing classes") vi.stubGlobal("CSS", { supports: () => false })
    render(createElement(Harness))
    expect(api.begin()).toBeNull()
    expect(makeAnimation).not.toHaveBeenCalled()
  })
})
