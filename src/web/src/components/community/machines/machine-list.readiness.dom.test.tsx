import React from "react"
import { IsRestoringProvider } from "@tanstack/react-query"
import { beforeEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"
import { communityKeys } from "@/lib/query-keys"
import { MachineList } from "./machine-list"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: load, getErrorMessage: () => "Unavailable" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock("@/hooks/community/use-bots", () => ({ useBots: () => ({ bots: [] }) }))
vi.mock("./pair-machine-sheet", () => ({ PairMachineSheet: () => null }))
vi.mock("./guide-me-avatar-motion", () => ({ GuideMeAvatarMotion: () => null }))
vi.mock("@/lib/community-onboarding", () => ({ useCommunityOnboarding: () => "done", startCommunityOnboarding: vi.fn() }))
vi.mock("@/lib/utils", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/utils")>(), getAppMode: () => "dev" }))

beforeEach(() => { load.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it.each([false, true])("keeps the real empty target unknown until its list is available (restoring=%s)", async restoring => {
  const { client } = await createCommunityQueryOwner()
  const primary = deferred<{ machines: [] }>()
  const observations = deferred<{ quotas: []; machineCapacity: { plan: { id: string; displayName: string }; isFounder: boolean; limit: number; ownedCount: number; onlineCount: number } }>()
  load.mockImplementation((url: string) => url.endsWith("view=list") ? primary.promise : observations.promise)
  const node = (restore: boolean) => <CommunityTestProvider client={client}>
    <IsRestoringProvider value={restore}>
      <CommunityModuleRouteContext value={{ href: "/c/me/machines", routeCommitted: false }}><MachineList /></CommunityModuleRouteContext>
    </IsRestoringProvider>
  </CommunityTestProvider>
  const view = render(node(restoring))
  expect(view.queryByText("No machines yet")).toBeNull()
  expect(view.queryByRole("button", { name: "Connect a machine" })).toBeNull()
  expect(view.container.querySelector('[data-slot="community-machines-heading"] [data-slot="skeleton"]')).not.toBeNull()
  view.rerender(node(false))
  await waitFor(() => expect(load).toHaveBeenCalledWith("/api/community/machines?view=list", expect.anything()))
  expect(client.getQueryState(communityKeys.machines())).toMatchObject({ status: "pending", fetchStatus: "fetching", data: undefined })
  expect(view.queryByText("No machines yet")).toBeNull()
  await act(async () => { primary.resolve({ machines: [] }) })
  expect(await view.findByText("No machines yet")).toBeVisible()
  expect(view.getByRole("button", { name: "Connect a machine" })).toBeDisabled()
  await act(async () => { observations.resolve({ quotas: [], machineCapacity: { plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 0, onlineCount: 0 } }) })
  await waitFor(() => expect(view.getByRole("button", { name: "Connect a machine" })).toBeEnabled())
})

it.each([false, true])("shows a complete cached empty list while its capacity remains unknown (restoring=%s)", async restoring => {
  const { client } = await createCommunityQueryOwner()
  const primary = deferred<{ machines: [] }>()
  const observations = deferred<{ quotas: [] }>()
  client.setQueryData(communityKeys.machines(), { machines: [], complete: true, observed: false, source: "restored_idb" })
  load.mockImplementation((url: string) => url.endsWith("view=list") ? primary.promise : observations.promise)
  const node = (restore: boolean) => <CommunityTestProvider client={client}>
    <IsRestoringProvider value={restore}>
      <CommunityModuleRouteContext value={{ href: "/c/me/machines", routeCommitted: false }}><MachineList /></CommunityModuleRouteContext>
    </IsRestoringProvider>
  </CommunityTestProvider>
  const view = render(node(restoring))
  const empty = view.getByText("No machines yet")
  expect(empty).toBeVisible()
  expect(view.getByRole("button", { name: "Connect a machine" })).toBeDisabled()
  expect(view.getByRole("button", { name: "Machine usage loading" })).toBeDisabled()
  view.rerender(node(false))
  await waitFor(() => expect(load).toHaveBeenCalledWith("/api/community/machines?view=list", expect.anything()))
  expect(view.getByText("No machines yet")).toBe(empty)
  await act(async () => { primary.resolve({ machines: [] }); observations.resolve({ quotas: [] }) })
  expect(view.getByText("No machines yet")).toBe(empty)
})
