import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApplicationOwnerProvider, createApplicationOwner } from "@/lib/application-owner"
import DeviceAuthPage from "./page"
const api = vi.hoisted(() => ({ verify: vi.fn(), approve: vi.fn(), deny: vi.fn(), replace: vi.fn(), push: vi.fn(), code: "ABCD-EFGH" }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams({ user_code: api.code }), useRouter: () => ({ replace: api.replace, push: api.push }) }))
vi.mock("@/lib/auth-client", () => ({ authClient: { device: Object.assign(api.verify, { approve: api.approve, deny: api.deny }) }, useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }), currentSessionViewer: () => "owner" }))
vi.mock("@/lib/application-owner", async original => ({ ...await original<typeof import("@/lib/application-owner")>(), PublicQueryProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/gradient-background", () => ({ GradientBackground: () => null }))
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const owner = createApplicationOwner("owner", client)
  const view = render(<QueryClientProvider client={client}><ApplicationOwnerProvider owner={owner}><DeviceAuthPage /></ApplicationOwnerProvider></QueryClientProvider>)
  return { ...view, owner, client }
}
beforeEach(() => {
  vi.clearAllMocks()
  api.code = "ABCD-EFGH"
  api.verify.mockResolvedValue({ data: { client_id: "alook-touch", status: "pending" } })
  api.approve.mockResolvedValue({ data: {} })
})
describe("device QR handoff", () => {
  it("moves only a server-verified Touch code to Devices without approving it", async () => {
    mount()
    await waitFor(() => expect(api.replace).toHaveBeenCalledWith("/c/me/bots?settings=devices&user_code=ABCD-EFGH"))
    expect(api.approve).not.toHaveBeenCalled()
    expect(api.deny).not.toHaveBeenCalled()
  })
  it("keeps the existing CLI approval route", async () => {
    api.verify.mockResolvedValue({ data: { client_id: "alook-cli", status: "pending" } })
    mount()
    const approve = await screen.findByRole("button", { name: "Approve" })
    expect(api.replace).not.toHaveBeenCalled()
    fireEvent.click(approve)
    await screen.findByText("✓ Device authorized")
    expect(api.approve).toHaveBeenCalledTimes(1)
  })
  it("does not redirect an expired code or missing client identity", async () => {
    api.verify.mockResolvedValueOnce({ error: { error_description: "Code expired" } })
    const view = mount()
    await screen.findByText("Code expired")
    expect(api.replace).not.toHaveBeenCalled()
    view.unmount()
    api.verify.mockResolvedValueOnce({ data: { status: "pending" } })
    mount()
    await screen.findByRole("button", { name: "Approve" })
    expect(api.replace).not.toHaveBeenCalled()
  })
  it("retires a late code verification before routing on account change", async () => {
    let resolve!: (value: unknown) => void
    api.verify.mockImplementation(() => new Promise(value => { resolve = value }))
    const view = mount()
    await waitFor(() => expect(api.verify).toHaveBeenCalledTimes(1))
    act(() => view.owner.lifecycle.setState(state => ({ active: false, generation: state.generation + 1 })))
    await act(async () => resolve({ data: { client_id: "alook-touch", status: "pending" } }))
    expect(api.replace).not.toHaveBeenCalled()
  })
})
