import { createElement, type ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), replace: vi.fn(), reload: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/c/me", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("@/lib/auth-session", () => ({ useSession: () => ({ data: { user: { id: "viewer", email: "viewer@example.test" } }, isPending: false, error: null, refetch: mocks.refetch }), currentSessionViewer: () => "viewer" }))
vi.mock("@/lib/community/last-community-route", () => ({ retireCommunityColdEntryAttempt: vi.fn() }))
vi.mock("@/components/community/shell/community-account-pending-frame", () => ({ CommunityAccountPendingFrame: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => createElement("button", { onClick }, children) }))
vi.mock("./community-authenticated-entry", () => { throw new Error("Shell chunk unavailable") })
import { CommunityLayoutClient } from "./community-layout-client"

afterEach(async () => { await vi.dynamicImportSettled(); vi.unstubAllGlobals() })

it("offers a document reload when the deferred authenticated module cannot load", async () => {
  const original = window
  vi.stubGlobal("window", new Proxy(original, { get: (target, key) => key === "location" ? { reload: mocks.reload } : Reflect.get(target, key) }))
  render(createElement(CommunityLayoutClient))
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the app"))
  fireEvent.click(screen.getByRole("button", { name: "Reload" }))
  expect(mocks.reload).toHaveBeenCalledOnce()
  expect(mocks.refetch).not.toHaveBeenCalled()
  expect(mocks.replace).not.toHaveBeenCalled()
})
