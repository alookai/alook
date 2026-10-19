import React from "react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { DeviceSettings } from "./device-settings"
import { TOUCH_PROVISION_SERVICE } from "@/lib/touch-setup"

const fixtures = vi.hoisted(() => ({
  available: true, accept: null as null | ((value: { data: string }) => void),
  start: vi.fn(async () => undefined), stop: vi.fn(), destroy: vi.fn(), pause: vi.fn(async () => true), videos: [] as HTMLVideoElement[],
  connect: vi.fn(async (): Promise<void> => {}), scan: vi.fn(), provision: vi.fn(async (): Promise<void> => {}), exchange: vi.fn(), cancel: vi.fn(async () => undefined),
  list: vi.fn(), verify: vi.fn(), approve: vi.fn(), deny: vi.fn(), revoke: vi.fn(),
}))
vi.mock("qr-scanner", () => ({ default: class {
  constructor(public $video: HTMLVideoElement, accept: (value: { data: string }) => void) { fixtures.accept = accept; fixtures.videos.push($video) }
  start = fixtures.start; stop = fixtures.stop; destroy = fixtures.destroy; pause = fixtures.pause
} }))
vi.mock("@/lib/touch-setup-browser", () => ({
  browserTouchSetupAvailable: () => fixtures.available,
  createBrowserTouchSetup: (_qr: unknown, signal: AbortSignal) => {
    signal.addEventListener("abort", () => fixtures.cancel(), { once: true })
    return { connect: fixtures.connect, scanNetworks: fixtures.scan, provision: fixtures.provision, exchangeEndpoint: fixtures.exchange, cancel: fixtures.cancel }
  },
}))
vi.mock("@/lib/auth-client", async original => ({ ...await original<typeof import("@/lib/auth-client")>(), authClient: { listSessions: fixtures.list, device: Object.assign(fixtures.verify, { approve: fixtures.approve, deny: fixtures.deny }), revokeSession: fixtures.revoke } }))
const code = JSON.stringify({ ver: "v1", name: "ALOOK_TOUCH_A1B2C3", pop: "0123456789abcdef0123456789abcdef", transport: "ble", security: 1, service_uuid: TOUCH_PROVISION_SERVICE })
function mount(strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const settings = <DeviceSettings userId="owner" active />
  const view = render(strict ? <React.StrictMode>{settings}</React.StrictMode> : settings, { wrapper: ({ children }) => <CommunityTestProvider userId="owner" client={client}>{children}</CommunityTestProvider> })
  return { ...view, client }
}
beforeEach(() => {
  vi.clearAllMocks(); fixtures.available = true; fixtures.accept = null; fixtures.videos.length = 0
  fixtures.start.mockResolvedValue(undefined); fixtures.connect.mockResolvedValue(undefined)
  fixtures.list.mockResolvedValue({ data: [] })
  fixtures.verify.mockResolvedValue({ data: { client_type: "touch", client_id: "configured-fixture-id", status: "pending" } })
  fixtures.approve.mockResolvedValue({ data: { success: true } })
  fixtures.scan.mockResolvedValue([{ ssid: "Board network", rssi: -40, secured: true }])
  fixtures.exchange.mockResolvedValue({ state: "ready", user_code: "ABCDEFGH" })
})
describe("Touch shared setup", () => {
  it("gives each replayed scanner its own preview so old cleanup cannot stop the current camera", async () => {
    mount(true); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await waitFor(() => expect(fixtures.videos.length).toBeGreaterThan(1))
    expect(new Set(fixtures.videos).size).toBe(fixtures.videos.length)
    const current = fixtures.videos.at(-1)!
    expect(current.isConnected).toBe(true)
    expect(screen.getByLabelText("Scan Touch setup code")).toBe(current)
    for (const previous of fixtures.videos.slice(0, -1)) expect(previous.isConnected).toBe(false)
  })
  it("stops the camera after one code, requires Connect Touch and uses normal explicit approval", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await waitFor(() => expect(fixtures.accept).not.toBeNull())
    await act(async () => { fixtures.accept!({ data: code }); fixtures.accept!({ data: code }) })
    expect(fixtures.pause).toHaveBeenCalledWith(true); expect(fixtures.destroy).toHaveBeenCalled()
    expect(fixtures.connect).not.toHaveBeenCalled(); expect(fixtures.approve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await screen.findByLabelText("Wi-Fi network")
    expect(fixtures.scan).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText("Wi-Fi password"), { target: { value: "board-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect Wi-Fi" }))
    await screen.findByTestId("device-authorization-review")
    expect(fixtures.provision).toHaveBeenCalledWith({ ssid: "Board network", rssi: -40, secured: true }, "board-password")
    expect(fixtures.exchange.mock.calls.map(value => value[0])).toEqual(["code", "ack"])
    expect(fixtures.exchange).toHaveBeenLastCalledWith("ack", "ABCDEFGH")
    expect(fixtures.approve).not.toHaveBeenCalled()
    expect((screen.getByLabelText("Device code") as HTMLInputElement).value).toBe("ABCDEFGH")
    fireEvent.click(screen.getByRole("button", { name: "Approve Touch" }))
    await waitFor(() => expect(fixtures.approve).toHaveBeenCalledTimes(1))
  })
  it("cancels a pending connection and rejects its late result after leaving Devices", async () => {
    let finish!: () => void
    fixtures.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await waitFor(() => expect(fixtures.connect).toHaveBeenCalledTimes(1))
    view.unmount(); expect(fixtures.cancel).toHaveBeenCalled()
    await act(async () => { finish() })
    expect(fixtures.scan).not.toHaveBeenCalled(); expect(fixtures.verify).not.toHaveBeenCalled(); expect(fixtures.approve).not.toHaveBeenCalled()
  })
  it("does not verify a code when Touch acknowledges a refreshed code", async () => {
    fixtures.exchange.mockResolvedValueOnce({ state: "ready", user_code: "ABCDEFGH" }).mockResolvedValueOnce({ state: "ready", user_code: "IJKL-MNOP" })
    mount(); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await screen.findByLabelText("Wi-Fi network")
    fireEvent.click(screen.getByRole("button", { name: "Connect Wi-Fi" }))
    await screen.findByRole("alert")
    expect(fixtures.verify).not.toHaveBeenCalled(); expect(fixtures.approve).not.toHaveBeenCalled()
    expect(fixtures.cancel).toHaveBeenCalled()
  })
  it("keeps raw transport errors out of mutation telemetry", async () => {
    fixtures.connect.mockRejectedValueOnce(new Error("private-wifi-password-and-proof"))
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await screen.findByRole("alert")
    const errors = view.client.getMutationCache().getAll().map(row => row.state.error).filter(Boolean)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toBe("Error: Touch setup failed.")
    expect(fixtures.verify).not.toHaveBeenCalled()
  })
  it("does not fetch or verify a code after cancelling credentials in flight", async () => {
    let finish!: () => void
    fixtures.provision.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    mount(); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await screen.findByLabelText("Wi-Fi network")
    fireEvent.click(screen.getByRole("button", { name: "Connect Wi-Fi" }))
    await waitFor(() => expect(fixtures.provision).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }))
    await act(async () => { finish() })
    expect(fixtures.cancel).toHaveBeenCalled(); expect(fixtures.exchange).not.toHaveBeenCalled(); expect(fixtures.verify).not.toHaveBeenCalled(); expect(fixtures.approve).not.toHaveBeenCalled()
  })
  it("ignores a late camera start failure after accepting the code", async () => {
    let fail!: (error: Error) => void
    fixtures.start.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { fail = reject }))
    mount(); fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    await act(async () => { fail(new Error("camera closed")) })
    expect(screen.getByRole("button", { name: "Connect Touch" })).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(fixtures.connect).not.toHaveBeenCalled()
  })
  it("keeps the new account attempt active when the old connection resolves", async () => {
    let finish!: () => void
    fixtures.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const options = { defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }
    const first = new QueryClient(options), next = new QueryClient(options)
    const account = (userId: string, client: QueryClient) => <CommunityTestProvider userId={userId} client={client}><DeviceSettings userId={userId} active /></CommunityTestProvider>
    const view = render(account("owner", first))
    fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await waitFor(() => expect(fixtures.connect).toHaveBeenCalledTimes(1))
    view.rerender(account("next-owner", next))
    await waitFor(() => expect(fixtures.cancel).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await act(async () => { fixtures.accept!({ data: code }) })
    fireEvent.click(screen.getByRole("button", { name: "Connect Touch" }))
    await screen.findByLabelText("Wi-Fi network")
    await act(async () => { finish() })
    expect(fixtures.scan).toHaveBeenCalledTimes(1)
    expect(fixtures.cancel).toHaveBeenCalledTimes(1)
    expect(fixtures.verify).not.toHaveBeenCalled(); expect(fixtures.approve).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Wi-Fi network")).toBeTruthy()
  })
  it("shows the browser capability limit and retains manual authorization", async () => {
    fixtures.available = false; mount()
    fireEvent.click(screen.getByRole("button", { name: "Add Touch" }))
    await screen.findByText(/This browser cannot connect/)
    expect(fixtures.start).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Device code")).toBeTruthy()
  })
})
