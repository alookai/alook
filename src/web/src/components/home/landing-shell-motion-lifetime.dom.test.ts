import React, { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor, type RenderResult } from "@/test/react-dom-harness"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"

const observed = vi.hoisted(() => ({
  owners: [] as Array<{ registry: CommunityDbRegistry; used: () => boolean }>,
}))

vi.mock("@/lib/community-db/collections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/community-db/collections")>()
  return {
    ...original,
    createCommunityDbRegistry: (...args: Parameters<typeof original.createCommunityDbRegistry>) => {
      const registry = original.createCommunityDbRegistry(...args)
      if (!observed.owners.some((owner) => owner.registry === registry)) {
        const collections = vi.spyOn(registry.dbClient, "collection")
        observed.owners.push({ registry, used: () => collections.mock.calls.some(([options]) => options.id.startsWith("community-live:")) })
      }
      return registry
    },
  }
})

vi.mock("./landing-shell-motion.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

import { LandingMobileChatMotion, LandingShellMotion } from "./landing-shell-motion"

const mounted: RenderResult[] = []

function mountPreview(kind: "desktop" | "mobile", beat: number) {
  const view = render(preview(kind, beat))
  mounted.push(view)
  return view
}

class PreviewBoundary extends React.Component<{ children?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    return this.state.error
      ? createElement("div", { "data-testid": "preview-error" }, this.state.error.message)
      : this.props.children
  }
}

function preview(kind: "desktop" | "mobile", beat: number) {
  return createElement(React.StrictMode, null,
    createElement(PreviewBoundary, null,
      kind === "desktop"
        ? createElement(LandingShellMotion, { scene: "server", beat })
        : createElement(LandingMobileChatMotion, { beat })))
}

beforeEach(() => {
  observed.owners.length = 0
  mounted.length = 0
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("matchMedia", () => ({
    matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true,
  }))
})

afterEach(async () => {
  for (const view of mounted) view.unmount()
  for (const { registry } of observed.owners) {
    await registry.cleanup()
    registry.queryClient.clear()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("landing preview Collection lifetime", () => {
  it.each(["desktop", "mobile"] as const)("keeps the actual %s consumers live through StrictMode effect replay and retires on unmount", async (kind) => {
    const view = mountPreview(kind, 0)
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)) })
    view.rerender(preview(kind, 6))
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)) })
    expect(view.queryByTestId("preview-error")).toBeNull()
    const used = observed.owners.filter((owner) => owner.used())
    expect(used).toHaveLength(1)
    expect(used[0]!.registry.runtime.lifecycle.get().active).toBe(true)
    expect(view.container.textContent).toContain("Gus")
    view.unmount()
    await waitFor(() => expect(used[0]!.registry.runtime.lifecycle.get().active).toBe(false))
    await waitFor(() => expect(used[0]!.registry.collections.profiles.status).toBe("cleaned-up"))
  })

  it("does not retire a separate surviving preview owner", async () => {
    const first = mountPreview("desktop", 0)
    const survivor = mountPreview("mobile", 0)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    first.unmount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    survivor.rerender(preview("mobile", 6))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    expect(survivor.queryByTestId("preview-error")).toBeNull()
    const used = observed.owners.filter((owner) => owner.used())
    expect(used).toHaveLength(2)
    expect(used[0]!.registry.runtime.lifecycle.get().active).toBe(false)
    expect(used[1]!.registry.runtime.lifecycle.get().active).toBe(true)
    expect(survivor.container.textContent).toContain("Gus")
    survivor.unmount()
    await waitFor(() => expect(used[1]!.registry.runtime.lifecycle.get().active).toBe(false))
  })
})
