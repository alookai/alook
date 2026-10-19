import { afterEach, describe, expect, it, vi } from "vitest"
import { createNativeTouchSetup } from "./native-touch-setup"
import { TOUCH_PROVISION_SERVICE } from "./touch-setup"
const invoke = vi.hoisted(() => vi.fn())
vi.mock("@alook/shared", () => ({ tauriInvoke: invoke }))
const qr = { ver: "v1" as const, name: "ALOOK_TOUCH_A1B2C3", pop: "0123456789abcdef0123456789abcdef", transport: "ble" as const, security: 1 as const, service_uuid: TOUCH_PROVISION_SERVICE }
afterEach(() => vi.clearAllMocks())
describe("native Touch bridge ownership", () => {
  it("does not dispatch a queued connection after cancellation", async () => {
    const controller = new AbortController()
    const transport = createNativeTouchSetup(qr, controller.signal, () => undefined)
    const observed = transport.connect().catch(error => error)
    controller.abort()
    expect((await observed).name).toBe("AbortError")
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["touch_setup_cancel"])
  })
  it("rejects late native code results and sends no acknowledgement after retirement", async () => {
    let finish!: (value: string) => void
    invoke.mockImplementation((name: string) => name === "touch_setup_exchange" ? new Promise(resolve => { finish = resolve }) : Promise.resolve())
    const controller = new AbortController()
    const transport = createNativeTouchSetup(qr, controller.signal, () => undefined)
    await transport.connect()
    const result = transport.exchangeEndpoint("code").catch(error => error)
    await Promise.resolve(); await Promise.resolve()
    controller.abort(); finish('{"state":"ready","user_code":"ABCD1234"}')
    expect((await result).name).toBe("AbortError")
    expect(invoke.mock.calls.filter(call => call[0] === "touch_setup_exchange")).toHaveLength(1)
  })
  it("bounds the native ack before dispatch and parses only a normal device code", async () => {
    invoke.mockResolvedValue('{"state":"ready","user_code":"ABCD1234"}')
    const transport = createNativeTouchSetup(qr, new AbortController().signal, () => undefined)
    await expect(transport.exchangeEndpoint("ack")).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
    await expect(transport.exchangeEndpoint("ack", "ABCD1234")).resolves.toEqual({ state: "ready", user_code: "ABCD1234" })
    expect(invoke).toHaveBeenCalledWith("touch_setup_exchange", expect.objectContaining({ action: "ack", userCode: "ABCD1234" }))
  })
})
