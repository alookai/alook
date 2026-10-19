import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createNativeTouchSetup } from "./native-touch-setup"
import { TOUCH_PROVISION_SERVICE } from "./touch-setup"
const invoke = vi.hoisted(() => vi.fn())
vi.mock("@alook/shared", async original => ({ ...await original<typeof import("@alook/shared")>(), tauriInvoke: invoke }))
const qr = { ver: "v1" as const, name: "ALOOK_TOUCH_A1B2C3", pop: "0123456789abcdef0123456789abcdef", transport: "ble" as const, security: 1 as const, service_uuid: TOUCH_PROVISION_SERVICE }
beforeEach(() => { invoke.mockReset() })
afterEach(() => vi.clearAllMocks())
describe("native Touch bridge ownership", () => {
  it("serializes scan and credentials after connection and retains one attempt through the grant acknowledgement", async () => {
    let connected!: () => void
    const networks = [{ ssid: "网络", rssi: -35, secured: true }]
    invoke.mockImplementation((name: string) => {
      if (name === "touch_setup_connect") return new Promise<void>(resolve => { connected = resolve })
      if (name === "touch_setup_scan") return Promise.resolve(networks)
      if (name === "touch_setup_exchange") return Promise.resolve('{"state":"ready","user_code":"ABCD2345"}')
      return Promise.resolve()
    })
    const transport = createNativeTouchSetup(qr, new AbortController().signal, () => undefined)
    const connect = transport.connect(), scan = transport.scanNetworks(), provision = transport.provision(networks[0], "密码密码")
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0][0]).toBe("touch_setup_connect")
    connected()
    await connect; await expect(scan).resolves.toBe(networks); await provision
    await expect(transport.exchangeEndpoint("code")).resolves.toEqual({ state: "ready", user_code: "ABCD2345" })
    await transport.exchangeEndpoint("ack", "ABCD2345"); await transport.cancel()
    const attemptId = invoke.mock.calls[0][1].attemptId
    expect(attemptId).toMatch(/^[0-9a-f-]{36}$/)
    expect(invoke.mock.calls).toEqual([
      ["touch_setup_connect", { attemptId, name: qr.name, pop: qr.pop, serviceUuid: qr.service_uuid }],
      ["touch_setup_scan", { attemptId }],
      ["touch_setup_provision", { attemptId, ssid: "网络", password: "密码密码" }],
      ["touch_setup_exchange", { attemptId, action: "code", userCode: null }],
      ["touch_setup_exchange", { attemptId, action: "ack", userCode: "ABCD2345" }],
      ["touch_setup_cancel", { attemptId }],
    ])
  })
  it.each(["scan", "provision"] as const)("rejects a late %s result and retires queued endpoint work", async operation => {
    let finish!: (value: unknown) => void
    const command = operation === "scan" ? "touch_setup_scan" : "touch_setup_provision"
    invoke.mockImplementation((name: string) => name === command ? new Promise(resolve => { finish = resolve }) : Promise.resolve())
    const controller = new AbortController()
    const transport = createNativeTouchSetup(qr, controller.signal, () => undefined)
    await transport.connect()
    const pending = (operation === "scan" ? transport.scanNetworks() : transport.provision({ ssid: "Secure", rssi: -20, secured: true }, "password")).catch(error => error)
    const queued = transport.exchangeEndpoint("code").catch(error => error)
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === command)).toBe(true))
    controller.abort(); finish([])
    expect((await pending).name).toBe("AbortError"); expect((await queued).name).toBe("AbortError")
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["touch_setup_connect", command, "touch_setup_cancel"])
  })
  it.each(["scan", "provision"] as const)("propagates a rejected native %s command without inventing a successful result", async operation => {
    const failure = new Error("Native permission denied")
    invoke.mockRejectedValueOnce(failure)
    const transport = createNativeTouchSetup(qr, new AbortController().signal, () => undefined)
    const pending = operation === "scan" ? transport.scanNetworks() : transport.provision({ ssid: "Secure", rssi: -20, secured: true }, "password")
    await expect(pending).rejects.toBe(failure)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it("does not dispatch work for a retired owner and uses a fresh id for the next attempt", async () => {
    invoke.mockResolvedValue(undefined)
    let active = true
    const owner = () => { if (!active) throw new DOMException("Retired owner", "AbortError") }
    const old = createNativeTouchSetup(qr, new AbortController().signal, owner)
    await old.connect()
    active = false
    await expect(old.scanNetworks()).rejects.toMatchObject({ name: "AbortError" })
    const next = createNativeTouchSetup(qr, new AbortController().signal, () => undefined)
    await next.connect()
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["touch_setup_connect", "touch_setup_connect"])
    expect(invoke.mock.calls[0][1].attemptId).not.toBe(invoke.mock.calls[1][1].attemptId)
  })
  it("keeps queued work retired even when the native cancellation command is rejected", async () => {
    invoke.mockRejectedValue(new Error("Native bridge already closed"))
    const controller = new AbortController()
    const transport = createNativeTouchSetup(qr, controller.signal, () => undefined)
    controller.abort()
    await expect(transport.scanNetworks()).rejects.toMatchObject({ name: "AbortError" })
    await Promise.resolve()
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["touch_setup_cancel"])
  })
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
