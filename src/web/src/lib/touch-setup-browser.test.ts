import { createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, webcrypto } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browserTouchSetupAvailable, createBrowserTouchSetup } from "./touch-setup-browser"
import { TOUCH_PROVISION_SERVICE, type TouchSetupQr, type TouchSetupTransport } from "./touch-setup"
import vector from "./__fixtures__/touch-security1.json"

const qr: TouchSetupQr = { ver: "v1", name: "ALOOK_TOUCH_A1B2C3", pop: vector.pop, transport: "ble", security: 1, service_uuid: TOUCH_PROVISION_SERVICE }
const bytes = (value: string) => Buffer.from(value, "hex")
const encoded = (value: string) => Buffer.from(value, "base64")
const dataView = (value: Uint8Array) => new DataView(Uint8Array.from(value).buffer)
const transports: TouchSetupTransport[] = []
const scanReplies = [
  "080110005a00",
  "080310006a0408011009",
  "080510007ae0010a150a0653656375726518baffffffffffffffff0128030a140a05477565737418ceffffffffffffffff0128000a150a0653656375726518ecffffffffffffffff0128030a150a0653656375726518abffffffffffffffff0128030a100a01ff18f6ffffffffffffffff0128030a0f0a0018f6ffffffffffffffff0128000a300a2178787878787878787878787878787878787878787878787878787878787878787818f6ffffffffffffffff0128030a170a08626164007373696418f6ffffffffffffffff0128030a150a06e7bd91e7bb9c18e2ffffffffffffffff012803",
]
let boardSequence = 0

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function peerCipher() {
  const privateKey = createPrivateKey({ key: bytes("302e020100300506032b656e04220420" + vector.clientPrivate), format: "der", type: "pkcs8" })
  const publicKey = createPublicKey({ key: bytes("302a300506032b656e032100de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f"), format: "der", type: "spki" })
  const secret = diffieHellman({ privateKey, publicKey }), proof = createHash("sha256").update(vector.pop).digest()
  const key = secret.map((value, index) => value ^ proof[index])
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.from(Array.from({ length: 16 }, (_, index) => index)))
  cipher.update(Buffer.alloc(64))
  return cipher
}

function board() {
  let cipher = peerCipher(), sessionStep = 0
  const requests: { endpoint: string; plain: Buffer }[] = [], wire: Buffer[] = []
  const state = {
    grant: Buffer.from('{"state":"ready","user_code":"ABCD2345"}'),
    session0: encoded(vector.response0), wifiFailed: false,
    holdWrite: null as null | { endpoint: string; gate: ReturnType<typeof deferred> },
    holdRead: null as null | { endpoint: string; gate: ReturnType<typeof deferred> },
  }
  function respond(endpoint: string, value: Uint8Array) {
    wire.push(Buffer.from(value))
    if (endpoint === "prov-session") {
      if (sessionStep++ === 0) {
        expect(Buffer.from(value).toString("base64")).toBe(vector.request0)
        cipher = peerCipher()
        return state.session0
      }
      expect(Buffer.from(value).toString("base64")).toBe(vector.request1)
      return encoded(vector.response1)
    }
    const plain = cipher.update(value)
    requests.push({ endpoint, plain })
    if (endpoint === "prov-scan") return cipher.update(bytes(scanReplies[plain[1] / 2]))
    if (endpoint === "prov-config") {
      const reply = plain[1] === 2 ? "08036a020800" : plain[1] === 4 ? "08057a020800" : state.wifiFailed ? "08015a0408001003" : "08015a0408001000"
      return cipher.update(bytes(reply))
    }
    expect(JSON.parse(plain.toString()).action).toMatch(/^(code|ack)$/)
    return cipher.update(state.grant)
  }
  const characteristics = new Map(["prov-session", "prov-scan", "prov-config", "alook-auth"].map(endpoint => {
    let response: Uint8Array = new Uint8Array()
    return [endpoint, {
      getDescriptor: vi.fn(async (id: number) => { expect(id).toBe(0x2901); return { readValue: async () => dataView(Buffer.from(endpoint)) } }),
      writeValue: vi.fn(async (value: Uint8Array) => {
        response = respond(endpoint, value)
        if (state.holdWrite?.endpoint === endpoint) await state.holdWrite.gate.promise
      }),
      readValue: vi.fn(async () => {
        const current = dataView(response)
        if (state.holdRead?.endpoint === endpoint) await state.holdRead.gate.promise
        return current
      }),
    }]
  }))
  const service = { getCharacteristics: vi.fn(async () => [...characteristics.values()]) }
  const gatt = {
    connected: false,
    connect: vi.fn(async () => { gatt.connected = true; sessionStep = 0; return gatt }),
    disconnect: vi.fn(() => { gatt.connected = false }),
    getPrimaryService: vi.fn(async (uuid: string) => { expect(uuid).toBe(TOUCH_PROVISION_SERVICE); return service }),
  }
  const device = Object.assign(new EventTarget(), { id: "public-fixture-" + ++boardSequence, name: qr.name, gatt })
  return { device, gatt, service, characteristics, state, requests, wire }
}

function attach(device: ReturnType<typeof board>["device"]) {
  const requestDevice = vi.fn(async () => device)
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() }, bluetooth: { requestDevice } })
  return requestDevice
}
function attempt(controller = new AbortController(), assertOwner: () => void = () => undefined) {
  const transport = createBrowserTouchSetup(qr, controller.signal, assertOwner)
  transports.push(transport)
  return transport
}

beforeEach(async () => {
  const privateKey = await webcrypto.subtle.importKey("pkcs8", bytes("302e020100300506032b656e04220420" + vector.clientPrivate), { name: "X25519" }, true, ["deriveBits"])
  const publicKey = await webcrypto.subtle.importKey("raw", encoded(vector.clientPublic), { name: "X25519" }, true, [])
  const subtle = {
    generateKey: vi.fn(async () => ({ privateKey, publicKey })),
    exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle), importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
    deriveBits: webcrypto.subtle.deriveBits.bind(webcrypto.subtle), digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
  }
  vi.stubGlobal("crypto", { subtle }); vi.stubGlobal("window", { isSecureContext: true, crypto: { subtle } })
  vi.stubGlobal("indexedDB", { cmp: (left: Uint8Array, right: Uint8Array) => Buffer.compare(Buffer.from(left), Buffer.from(right)) })
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.cancel()))
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe("Touch browser transport over Security1 GATT", () => {
  it("checks secure media, Bluetooth and crypto capabilities before offering setup", () => {
    attach(board().device)
    expect(browserTouchSetupAvailable()).toBe(true)
    vi.stubGlobal("window", undefined); expect(browserTouchSetupAvailable()).toBe(false)
    vi.stubGlobal("window", { isSecureContext: false }); expect(browserTouchSetupAvailable()).toBe(false)
    vi.stubGlobal("window", { isSecureContext: true })
    for (const navigator of [{}, { mediaDevices: {} }, { mediaDevices: { getUserMedia: vi.fn() } }, { mediaDevices: { getUserMedia: vi.fn() }, bluetooth: {} }]) {
      vi.stubGlobal("navigator", navigator); expect(browserTouchSetupAvailable()).toBe(false)
    }
    attach(board().device); vi.stubGlobal("crypto", {}); expect(browserTouchSetupAvailable()).toBe(false)
  })
  it("requests the chooser synchronously and executes the actual secure scan, credentials and code acknowledgement", async () => {
    const peer = board(), requestDevice = attach(peer.device), transport = attempt()
    const connecting = transport.connect()
    expect(requestDevice).toHaveBeenCalledExactlyOnceWith({ filters: [{ name: qr.name }], optionalServices: [TOUCH_PROVISION_SERVICE] })
    await connecting
    expect(peer.characteristics.get("prov-session")!.writeValue).toHaveBeenCalledTimes(2)
    await expect(transport.scanNetworks()).resolves.toEqual([
      { ssid: "Secure", rssi: -20, secured: true }, { ssid: "网络", rssi: -30, secured: true }, { ssid: "Guest", rssi: -50, secured: false },
    ])
    expect(peer.requests.map(request => request.plain.toString("hex"))).toEqual(["0800100052080801100018002078", "080210006200", "08041000720408001009"])
    await transport.provision({ ssid: "Secure", rssi: -20, secured: true }, "password")
    expect(peer.requests.filter(request => request.endpoint === "prov-config").map(request => request.plain.toString("hex"))).toEqual(["080262120a06536563757265120870617373776f7264", "08047200", "08005200"])
    await expect(transport.exchangeEndpoint("code")).resolves.toEqual({ state: "ready", user_code: "ABCD2345" })
    await expect(transport.exchangeEndpoint("ack", "ABCD2345")).resolves.toEqual({ state: "ready", user_code: "ABCD2345" })
    expect(peer.requests.filter(request => request.endpoint === "alook-auth").map(request => JSON.parse(request.plain.toString()))).toEqual([{ action: "code" }, { action: "ack", user_code: "ABCD2345" }])
    expect(peer.wire.some(value => value.includes(Buffer.from("password")) || value.includes(Buffer.from("Secure")))).toBe(false)
    await transport.cancel(); expect(peer.gatt.connected).toBe(false); expect(peer.gatt.disconnect).toHaveBeenCalledTimes(1)
  })
  it("serializes encrypted scan and credential traffic without overlapping GATT commands", async () => {
    const peer = board(); attach(peer.device); const transport = attempt()
    await transport.connect()
    const gate = deferred(); peer.state.holdWrite = { endpoint: "prov-scan", gate }
    const completed = Promise.all([transport.scanNetworks(), transport.provision({ ssid: "Guest", rssi: -50, secured: false }, "")])
    await vi.waitFor(() => expect(peer.requests).toHaveLength(1))
    expect(peer.characteristics.get("prov-config")!.writeValue).not.toHaveBeenCalled()
    gate.resolve(); await completed
    expect(peer.requests.map(request => request.endpoint)).toEqual(["prov-scan", "prov-scan", "prov-scan", "prov-config", "prov-config", "prov-config"])
    expect(peer.requests[3].plain.toString("hex")).toBe("080262090a0547756573741200")
  })
  it("encodes UTF-8 credentials and accepts the byte limits without truncation", async () => {
    const peer = board(); attach(peer.device); const transport = attempt(); await transport.connect()
    await transport.provision({ ssid: "网络", rssi: -30, secured: true }, "密码密码")
    const first = peer.requests[0].plain
    expect(first.includes(Buffer.from("网络"))).toBe(true); expect(first.includes(Buffer.from("密码密码"))).toBe(true)
    const ssid = "中".repeat(10) + "ab", password = "p".repeat(63)
    await transport.provision({ ssid, rssi: -30, secured: true }, password)
    expect(peer.requests[3].plain.includes(Buffer.from(ssid))).toBe(true); expect(peer.requests[3].plain.includes(Buffer.from(password))).toBe(true)
  })
  it.each([
    ["", "password"], ["x".repeat(33), "password"], ["中".repeat(11), "password"], ["bad\0ssid", "password"],
    ["Secure", "short"], ["Secure", "p".repeat(64)], ["Secure", "pass\0word"],
  ])("rejects invalid credential bytes before a GATT write (%#)", async (ssid, password) => {
    const peer = board(); attach(peer.device); const transport = attempt(); await transport.connect()
    await expect(transport.provision({ ssid, rssi: -20, secured: true }, password)).rejects.toThrow("Check the Wi-Fi password.")
    expect(peer.characteristics.get("prov-config")!.writeValue).not.toHaveBeenCalled()
  })
  it("returns a vendor Wi-Fi failure instead of treating configuration writes as success", async () => {
    const peer = board(); peer.state.wifiFailed = true; attach(peer.device); const transport = attempt(); await transport.connect()
    await expect(transport.provision({ ssid: "Secure", rssi: -20, secured: true }, "password")).rejects.toThrow("WiFi connection failed")
    expect(peer.requests.map(request => request.endpoint)).toEqual(["prov-config", "prov-config", "prov-config"])
  })
  it("parses pending grants and rejects malformed acknowledgements before transmitting them", async () => {
    const peer = board(); peer.state.grant = Buffer.from('{"state":"pending"}'); attach(peer.device); const transport = attempt(); await transport.connect()
    await expect(transport.exchangeEndpoint("code")).resolves.toEqual({ state: "pending" })
    await expect(transport.exchangeEndpoint("ack", "bad")).rejects.toThrow("Touch returned an invalid response.")
    expect(peer.requests).toHaveLength(1)
  })
  it.each(["null", '{"state":"ready","user_code":"bad"}', "x".repeat(257)])("rejects malformed encrypted endpoint responses (%#)", async response => {
    const peer = board(); peer.state.grant = Buffer.from(response); attach(peer.device); const transport = attempt(); await transport.connect()
    await expect(transport.exchangeEndpoint("code")).rejects.toThrow("Touch returned an invalid response.")
  })
  it.each(["write", "read"] as const)("bounds a failed GATT %s without exporting raw radio details", async operation => {
    const peer = board(); attach(peer.device); const transport = attempt(); await transport.connect()
    const characteristic = peer.characteristics.get("alook-auth")!
    if (operation === "write") characteristic.writeValue.mockRejectedValueOnce(new Error("private-radio-detail"))
    else characteristic.readValue.mockRejectedValueOnce(new Error("private-radio-detail"))
    const failure = await transport.exchangeEndpoint("code").catch(error => error)
    expect(failure).toBeInstanceOf(Error); expect(failure.message).toContain("Touch connection failed."); expect(failure.message).not.toContain("private-radio-detail")
  })
  it.each(["write", "read"] as const)("rejects a late GATT %s after cancellation without disconnecting the new same-device attempt", async operation => {
    const peer = board(); attach(peer.device); const controller = new AbortController(), old = attempt(controller)
    await old.connect()
    const gate = deferred()
    if (operation === "write") peer.state.holdWrite = { endpoint: "alook-auth", gate }
    else peer.state.holdRead = { endpoint: "alook-auth", gate }
    const pending = old.exchangeEndpoint("code").catch(error => error)
    await vi.waitFor(() => expect(peer.characteristics.get("alook-auth")![operation === "write" ? "writeValue" : "readValue"]).toHaveBeenCalledTimes(1))
    controller.abort(); expect(peer.gatt.disconnect).toHaveBeenCalledTimes(1)
    const next = attempt(); await next.connect(); await next.scanNetworks()
    gate.resolve()
    const failure = await pending
    expect(failure).toBeInstanceOf(Error); expect(failure.message).toContain(controller.signal.reason.message)
    expect(peer.requests.filter(request => request.endpoint === "alook-auth")).toHaveLength(1)
    expect(peer.gatt.connected).toBe(true); expect(peer.gatt.disconnect).toHaveBeenCalledTimes(1)
    await expect(next.scanNetworks()).resolves.toHaveLength(3)
  })
  it("discards a late chooser result before opening GATT", async () => {
    const peer = board(), requestDevice = attach(peer.device), gate = deferred<typeof peer.device>()
    requestDevice.mockReturnValueOnce(gate.promise)
    const controller = new AbortController(), transport = attempt(controller), pending = transport.connect().catch(error => error)
    expect(requestDevice).toHaveBeenCalledTimes(1)
    controller.abort(); gate.resolve(peer.device)
    expect((await pending).name).toBe("AbortError"); expect(peer.gatt.connect).not.toHaveBeenCalled()
  })
  it.each([false, true])("preserves the new GATT owner when an older same-device connection finishes (cancelled=%s)", async cancelled => {
    const peer = board(); attach(peer.device); const gate = deferred<typeof peer.gatt>()
    peer.gatt.connect.mockReturnValueOnce(gate.promise)
    const controller = new AbortController(), old = attempt(controller), pending = old.connect().catch(error => error)
    await vi.waitFor(() => expect(peer.gatt.connect).toHaveBeenCalledTimes(1))
    if (cancelled) controller.abort()
    const next = attempt(); await next.connect(); gate.resolve(peer.gatt)
    expect((await pending).name).toBe("AbortError"); expect(peer.gatt.disconnect).not.toHaveBeenCalled()
    await expect(next.scanNetworks()).resolves.toHaveLength(3)
    await next.cancel(); expect(peer.gatt.disconnect).toHaveBeenCalledTimes(1)
  })
  it("rejects a denied chooser and an incomplete service without starting credentials", async () => {
    const peer = board(), requestDevice = attach(peer.device), denied = new DOMException("No device selected", "NotFoundError")
    requestDevice.mockRejectedValueOnce(denied)
    await expect(attempt().connect()).rejects.toBe(denied); expect(peer.gatt.connect).not.toHaveBeenCalled()
    peer.service.getCharacteristics.mockResolvedValueOnce([...peer.characteristics.values()].slice(0, 3))
    await expect(attempt().connect()).rejects.toThrow("Touch setup service is incomplete.")
    expect(peer.gatt.disconnect).toHaveBeenCalledTimes(1); expect(peer.requests).toHaveLength(0)
  })
  it("rejects a Security0 peer using the actual client handshake", async () => {
    const peer = board(); peer.state.session0 = encoded(vector.security0); attach(peer.device)
    await expect(attempt().connect()).rejects.toThrow("Touch secure session failed.")
    expect(peer.requests).toHaveLength(0)
  })
  it("retires on a GATT disconnect and refuses further encrypted work", async () => {
    const peer = board(); attach(peer.device); const remove = vi.spyOn(peer.device, "removeEventListener"), transport = attempt()
    await transport.connect(); peer.gatt.connected = false; peer.device.dispatchEvent(new Event("gattserverdisconnected"))
    await expect(transport.scanNetworks()).rejects.toThrow("Not connected to device")
    expect(remove).toHaveBeenCalledWith("gattserverdisconnected", expect.any(Function)); expect(peer.requests).toHaveLength(0)
  })
  it("does not dispatch a queued operation after its account owner retires", async () => {
    const peer = board(); attach(peer.device); let active = true
    const transport = attempt(new AbortController(), () => { if (!active) throw new DOMException("Retired owner", "AbortError") })
    await transport.connect(); active = false
    await expect(transport.scanNetworks()).rejects.toMatchObject({ name: "AbortError" }); expect(peer.requests).toHaveLength(0)
  })
})
