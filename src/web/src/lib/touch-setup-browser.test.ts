import { afterEach, describe, expect, it, vi } from "vitest"
import { createBrowserTouchSetup } from "./touch-setup-browser"
import { TOUCH_PROVISION_SERVICE, type TouchSetupQr } from "./touch-setup"

const sdk = vi.hoisted(() => ({ pop: vi.fn(), session: vi.fn(async () => undefined) }))
vi.mock("esp-ble-prov", () => ({
  Security1: class { constructor(options: unknown) { sdk.pop(options) } },
  ESPProvisioner: class {
    device: unknown = null; server: unknown = null; service: unknown = null; endpoints = new Map()
    establishSession = sdk.session
    async writeValue(endpoint: string, bytes: Uint8Array) { await this.endpoints.get(endpoint).writeValue(bytes) }
    async readValue(endpoint: string) { return new Uint8Array((await this.endpoints.get(endpoint).readValue()).buffer) }
  },
}))
const qr: TouchSetupQr = { ver: "v1", name: "ALOOK_TOUCH_A1B2C3", pop: "0123456789abcdef0123456789abcdef", transport: "ble", security: 1, service_uuid: TOUCH_PROVISION_SERVICE }
function board(id: string) {
  const characteristics = ["prov-session", "prov-scan", "prov-config", "alook-auth"].map(name => ({ getDescriptor: async () => ({ readValue: async () => new TextEncoder().encode(name) }) }))
  const gatt = { connected: false, disconnect: vi.fn(() => { gatt.connected = false }), connect: vi.fn(async () => { gatt.connected = true; return gatt }), getPrimaryService: vi.fn(async () => ({ getCharacteristics: async () => characteristics })) }
  return { id, name: qr.name, gatt, addEventListener: vi.fn(), removeEventListener: vi.fn() }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
describe("Touch browser transport lifetime", () => {
  it("requests the chooser in the click call and discards a late selection before GATT", async () => {
    let choose!: (value: unknown) => void
    const requestDevice = vi.fn(() => new Promise(resolve => { choose = resolve }))
    vi.stubGlobal("navigator", { bluetooth: { requestDevice } })
    const controller = new AbortController(), device = board("late")
    const transport = createBrowserTouchSetup(qr, controller.signal, () => undefined)
    const pending = transport.connect(); const observed = pending.catch(error => error)
    expect(requestDevice).toHaveBeenCalledTimes(1)
    controller.abort(); choose(device)
    expect((await observed).name).toBe("AbortError")
    expect(device.gatt.connect).not.toHaveBeenCalled()
    expect(sdk.session).not.toHaveBeenCalled()
    expect(sdk.pop).toHaveBeenCalledWith({ pop: qr.pop })
  })
  it("a cancelled in-flight connection cannot disconnect a newer attempt on the same board", async () => {
    const device = board("shared")
    let finishOld!: (value: unknown) => void
    device.gatt.connect.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    vi.stubGlobal("navigator", { bluetooth: { requestDevice: vi.fn(async () => device) } })
    const oldController = new AbortController(), nextController = new AbortController()
    const old = createBrowserTouchSetup(qr, oldController.signal, () => undefined)
    const pending = old.connect().catch(error => error)
    await Promise.resolve(); await Promise.resolve()
    oldController.abort()
    const next = createBrowserTouchSetup(qr, nextController.signal, () => undefined)
    await next.connect()
    finishOld(device.gatt)
    expect((await pending).name).toBe("AbortError")
    expect(device.gatt.disconnect).not.toHaveBeenCalled()
    expect(device.gatt.connected).toBe(true)
    await next.cancel(); expect(device.gatt.disconnect).toHaveBeenCalledTimes(1)
  })
})
