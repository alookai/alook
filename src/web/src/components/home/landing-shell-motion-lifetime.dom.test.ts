import React, { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, waitFor, type RenderResult } from "@/test/react-dom-harness"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { profileSchema } from "@/lib/community-db/schema"
import { communityRowData, writeCommunityCollectionChanges } from "@/lib/community-db/write"
import { profileResourceFixture } from "@/test/community-resource-fixtures"

const observed = vi.hoisted(() => ({
  owners: [] as Array<{ registry: CommunityDbRegistry }>,
}))

vi.mock("@/lib/community-db/collections", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/community-db/collections")>()
  return {
    ...original,
    createCommunityDbRegistry: (...args: Parameters<typeof original.createCommunityDbRegistry>) => {
      const registry = original.createCommunityDbRegistry(...args)
      if (!observed.owners.some((owner) => owner.registry === registry)) {
        observed.owners.push({ registry })
        writeCommunityCollectionChanges(registry, "profiles", [...LANDING_PREVIEW_PROFILES.values()].map((profile) => profileResourceFixture(profile)))
      }
      return registry
    },
  }
})

vi.mock("@/stores/community/profile-preview", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/stores/community/profile-preview")>(),
  useCommunityPreviewProfiles: () => null,
}))

vi.mock("./landing-shell-motion.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

import { LANDING_PREVIEW_PROFILES, LandingMobileChatMotion, LandingShellMotion } from "./landing-shell-motion"

const mounted: RenderResult[] = []
const profileId = [...LANDING_PREVIEW_PROFILES].find(([, profile]) => profile.name === "Gus")![0]

type ObservedOwner = (typeof observed.owners)[number]

async function renameProfile(owner: ObservedOwner, name: string) {
  await owner.registry.collections.profiles.preload()
  const profile = profileSchema.parse(communityRowData(owner.registry.collections.profiles.get(profileId)))
  await writeCommunityCollectionChanges(owner.registry, "profiles", [{ ...profile, name }])
}

async function publishOwnerNames() {
  const candidates = observed.owners.map((owner, index) => ({ ...owner, name: `Gus lifetime [${index}]` }))
  await act(async () => {
    for (const owner of candidates) await renameProfile(owner, owner.name)
  })
  return candidates
}

function visibleOwners(view: RenderResult, candidates: Array<ObservedOwner & { name: string }>) {
  return candidates.filter((owner) => view.container.textContent?.includes(owner.name))
}

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
  const errors: unknown[] = []
  for (const view of mounted) {
    try { view.unmount() } catch (error) { errors.push(error) }
  }
  for (const { registry } of observed.owners) {
    try { await registry.cleanup() } catch (error) { errors.push(error) }
    try { registry.queryClient.clear() } catch (error) { errors.push(error) }
  }
  try { vi.unstubAllGlobals() } catch (error) { errors.push(error) }
  try { vi.restoreAllMocks() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Failed to clean up landing preview resources")
})

describe("landing preview Collection lifetime", () => {
  it.each(["desktop", "mobile"] as const)("keeps the actual %s consumers live through StrictMode effect replay and retires on unmount", async (kind) => {
    const view = mountPreview(kind, 0)
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)) })
    view.rerender(preview(kind, 6))
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 10)) })
    expect(view.queryByTestId("preview-error")).toBeNull()
    const candidates = await publishOwnerNames()
    await waitFor(() => expect(visibleOwners(view, candidates)).toHaveLength(1))
    const used = visibleOwners(view, candidates)
    expect(used).toHaveLength(1)
    expect(view.getAllByText(used[0]!.name, { exact: true })[0]).toBeVisible()
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
    const candidates = await publishOwnerNames()
    await waitFor(() => {
      expect(visibleOwners(first, candidates)).toHaveLength(1)
      expect(visibleOwners(survivor, candidates)).toHaveLength(1)
    })
    const used = [...new Set([...visibleOwners(first, candidates), ...visibleOwners(survivor, candidates)])]
    expect(used).toHaveLength(2)
    expect(first.getAllByText(used[0]!.name, { exact: true })[0]).toBeVisible()
    expect(survivor.getAllByText(used[1]!.name, { exact: true })[0]).toBeVisible()
    first.unmount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    survivor.rerender(preview("mobile", 6))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    expect(survivor.queryByTestId("preview-error")).toBeNull()
    expect(used).toHaveLength(2)
    expect(used[0]!.registry.runtime.lifecycle.get().active).toBe(false)
    expect(used[1]!.registry.runtime.lifecycle.get().active).toBe(true)
    expect(survivor.container.textContent).toContain("Gus")
    await act(async () => { await renameProfile(used[1]!, "Gus surviving update") })
    await waitFor(() => expect(survivor.container.textContent).toContain("Gus surviving update"))
    expect(survivor.getAllByText("Gus surviving update", { exact: true })[0]).toBeVisible()
    await waitFor(() => expect(used[0]!.registry.collections.profiles.status).toBe("cleaned-up"))
    survivor.unmount()
    await waitFor(() => expect(used[1]!.registry.runtime.lifecycle.get().active).toBe(false))
    await waitFor(() => expect(used[1]!.registry.collections.profiles.status).toBe("cleaned-up"))
  })
})
