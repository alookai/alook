import "fake-indexeddb/auto"
import React, { Component, type ReactNode } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { dehydrate } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { writeCommunityCollectionChanges } from "@/lib/community-db/write"
import { profileResourceFixture } from "@/test/community-resource-fixtures"
import { clearAllPersistedCaches, createIdbPersister, PERSIST_BUSTER, readPersistedAccountIdentity } from "@/lib/query-persister"
import { tid } from "@/lib/community/testids"

const transport = vi.hoisted(() => { const load = vi.fn(); vi.stubGlobal("fetch", load); return load })
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me/c1", useSearchParams: () => new URLSearchParams(), useRouter: () => router, notFound: () => { throw new Error("Unexpected missing route") } }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
import { CommunityLayoutClient } from "./community-layout-client"
import { authClient } from "@/lib/auth-session"
class CaptureFailure extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() { return this.state.error ? <pre data-testid="cold-render-error">{this.state.error.stack}</pre> : this.props.children }
}
let mounted: ReturnType<typeof render> | undefined
beforeEach(async () => {
  await clearAllPersistedCaches()
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === tid.messageScroller ? 600 : 0 })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === tid.messageScroller ? 640 : 0 })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === tid.messageScroller ? 600 : 0 })
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === tid.messageScroller ? 640 : 0 })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 640, this.dataset.testid === tid.messageScroller ? 600 : this.matches("[data-index], [data-msg-id]") ? 48 : 0)
  })
  transport.mockReset().mockRejectedValue(new TypeError("Offline"))
})
afterEach(async () => {
  mounted?.unmount()
  mounted = undefined
  await vi.dynamicImportSettled()
  transport.mockResolvedValue(Response.json(null))
  await act(async () => authClient.$store.atoms.session.get().refetch())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)) })
  await clearAllPersistedCaches()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it("keeps the full cold account and DM route mounted with a failed real SDK check", async () => {
  const owner = await createCommunityQueryOwner("viewer")
  await writeCommunityCollectionChanges(owner.registry, "profiles", [{ ...profileResourceFixture(), aboutMe: "", bannerColor: null, statusEmoji: null, statusText: "" }])
  await seedConversationEntry(owner.client, dmConversationEntryFixture())
  const writer = createIdbPersister("viewer")
  await writer.persistClient({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) })
  await writer.rememberAccountIdentity({ id: "viewer", email: "viewer@example.test" }, () => undefined)
  await waitFor(async () => expect(await readPersistedAccountIdentity()).toEqual({ id: "viewer", email: "viewer@example.test" }))
  mounted = render(<CaptureFailure><CommunityLayoutClient /></CaptureFailure>)
  await waitFor(() => {
    expect(screen.queryByTestId("cold-render-error")?.textContent).toBeUndefined()
    expect(screen.getByTestId(tid.dmHeaderTitle)).toHaveTextContent("Peer")
    expect(screen.getByText("Body")).toBeInTheDocument()
    expect(screen.getByTestId(tid.composerInput).querySelector('[contenteditable="true"]')).not.toBeNull()
  }, { timeout: 5000 })
  expect(transport.mock.calls.filter(([input]) => {
    const path = new URL(String(input), "http://localhost").pathname
    return path.startsWith("/api/community/") || path === "/api/ws/token"
  })).toEqual([])
})
