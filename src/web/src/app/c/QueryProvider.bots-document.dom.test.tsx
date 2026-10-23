import "fake-indexeddb/auto"
import React from "react"
import { useIsRestoring } from "@tanstack/react-query"
import type { Database } from "@alook/shared"
import { beforeEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import type { QualifiedPersister } from "@/lib/query-persister"
const mocks = vi.hoisted(() => ({ restore: vi.fn(), api: vi.fn(), bots: vi.fn(), machines: vi.fn(),
  persistClient: vi.fn(async () => {}), removeClient: vi.fn(async () => {}), isCurrent: vi.fn(async () => true), retireAccount: vi.fn(async () => {}), retireChannels: vi.fn(async () => {}),
}))
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }), currentSessionViewer: () => "viewer" }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me/bots", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => mocks.api(...args) }))
vi.mock("@/lib/query-persister", async original => ({ ...await original<typeof import("@/lib/query-persister")>(), createIdbPersister: () => ({ ...mocks, restoreClient: mocks.restore }) satisfies QualifiedPersister }))
vi.mock("@/lib/community/bots.server", () => ({ readCommunityBots: mocks.bots }))
vi.mock("@/lib/community/machines.server", () => ({ readCommunityMachineList: mocks.machines }))
vi.mock("@/components/community/bots/create-bot-sheet", () => ({ CreateBotSheet: () => null }))
vi.mock("@/components/community/billing/billing-sheet", () => ({ BillingSheet: () => null }))
vi.mock("@/components/community/onboarding-tiles/create-tile", () => ({ CreateTile: () => React.createElement("div") }))
import { readCommunityDocumentSeed } from "@/lib/community/document-seed.server"
import { QueryProvider } from "@/app/c/QueryProvider"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { BotList } from "@/components/community/bots/bot-list"
const profile = { id: "viewer", name: "Viewer", discriminator: "0042", avatar: "/avatar", avatarVersion: 1, aboutMe: "", bannerColor: null, statusEmoji: null, statusText: "" }
const bots = { bots: [], plan: { id: "free", displayName: "Free" }, isFounder: false, limit: 1, ownedCount: 0, activeCount: 0 }
beforeEach(() => {
  localStorage.clear()
  mocks.restore.mockReset()
  mocks.api.mockReset()
  mocks.bots.mockReset().mockResolvedValue(bots)
  mocks.machines.mockReset().mockResolvedValue({ machines: [] })
})
it("keeps actual empty Bots heading and CTA stable through native provider restore while HTTP waits", async () => {
  const seed = await readCommunityDocumentSeed({} as Database, "viewer", "/c/me/bots", profile)
  let restore!: (value: undefined) => void
  mocks.restore.mockReturnValue(new Promise<undefined>(resolve => { restore = resolve }))
  let release!: (value: unknown) => void
  const live = new Promise(resolve => { release = resolve })
  mocks.api.mockImplementation((url: string) => url.includes("view=observations") ? Promise.resolve({ quotas: [] }) : live)
  let registry!: CommunityDbRegistry, restoring = true
  function Probe() {
    const owner = useOptionalCommunityDbRegistry()!
    const phase = useIsRestoring()
    React.useLayoutEffect(() => { registry = owner; restoring = phase }, [owner, phase])
    return <BotList />
  }
  const view = render(<QueryProvider userId="viewer" initialSeed={seed}><CurrentUserProvider initialUser={{ ...profile, email: "viewer@test.local" }}><Probe /></CurrentUserProvider></QueryProvider>)
  const sample = () => ({ heading: view.container.querySelector("h2")?.textContent, button: Array.from(view.container.querySelectorAll("button")).find(button => /machine|bot/i.test(button.textContent ?? ""))?.textContent })
  try {
    expect(restoring).toBe(true)
    const before = sample()
    expect(before).toEqual({ heading: "Connect a machine first", button: "Connect a machine" })
    await act(async () => restore(undefined))
    await waitFor(() => expect(restoring).toBe(false))
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith("/api/community/machines?view=observations", expect.anything()))
    expect(sample()).toEqual(before)
    expect(view.container.textContent).not.toContain("Checking machines")
    expect(mocks.api.mock.calls.filter(([url]) => String(url).includes("view=list"))).toHaveLength(0)
  } finally {
    restore(undefined); release({ machines: [] }); view.unmount()
    await waitFor(() => expect(registry.collections.messages.status).toBe("cleaned-up"))
  }
})
it.each(["bots", "machines"] as const)("retains the independent successful Bots-route resource when %s loader fails", async failed => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  mocks[failed].mockRejectedValue(new Error("bounded fixture failure"))
  try {
    const seed = await readCommunityDocumentSeed({} as Database, "viewer", "/c/me/bots", profile)
    expect(mocks.bots).toHaveBeenCalledWith(expect.anything(), "viewer")
    expect(mocks.machines).toHaveBeenCalledWith(expect.anything(), "viewer")
    if (failed === "machines") { expect(seed.bots).toEqual(bots); expect(seed.machines).toBeUndefined() }
    else { expect(seed.bots).toBeUndefined(); expect(seed.machines).toEqual({ machines: [] }) }
    expect(seed.selfProfile).toEqual(profile)
    expect(warn).toHaveBeenCalledWith("[community] document resource prefetch unavailable", { kind: "bots", phase: "read-module", channelId: null, generatedAt: seed.generatedAt })
  } finally { warn.mockRestore() }
})
