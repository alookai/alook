/// <reference types="web-bluetooth" />
import { ESPProvisioner, Security1 } from "esp-ble-prov"
import { parseTouchGrant, touchEndpointRequest, touchSetupGuard, touchSetupQueue, type TouchNetwork, type TouchSetupQr, type TouchSetupTransport } from "./touch-setup"

const connections = new Map<string, ScopedProvisioner>()

export function browserTouchSetupAvailable() {
  return typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!navigator.bluetooth?.requestDevice && !!crypto.subtle
}

export class TouchSecurity1 extends Security1 {
  override async setup0Request() { try { return await super.setup0Request() } catch { throw new Error("Touch secure session failed.") } }
  override async setup0Response(response: Uint8Array) { try { await super.setup0Response(response) } catch { throw new Error("Touch secure session failed.") } }
  override setup1Request() { try { return super.setup1Request() } catch { throw new Error("Touch secure session failed.") } }
  override setup1Response(response: Uint8Array) { try { super.setup1Response(response) } catch { throw new Error("Touch secure session failed.") } }
}

class ScopedProvisioner extends ESPProvisioner {
  private closed = false
  private readonly assertActive: () => void
  private readonly disconnected = () => { void this.disconnect() }

  constructor(private readonly qr: TouchSetupQr, signal: AbortSignal, assertOwner: () => void) {
    super({ serviceUUID: qr.service_uuid, deviceNamePrefix: qr.name, security: new TouchSecurity1({ pop: qr.pop }) })
    this.assertActive = touchSetupGuard(signal, assertOwner)
    signal.addEventListener("abort", () => { void this.disconnect() }, { once: true })
  }

  override get isConnected() { return !this.closed && !!this.server?.connected && !!this.service && !!this.device && connections.get(this.device.id) === this }

  private check() { this.assertActive(); if (this.closed) throw new DOMException("Touch setup cancelled", "AbortError") }

  override async connect() {
    this.check()
    const selected = await navigator.bluetooth.requestDevice({ filters: [{ name: this.qr.name }], optionalServices: [this.qr.service_uuid] })
    this.check()
    this.device = selected
    connections.set(selected.id, this)
    let server: BluetoothRemoteGATTServer | undefined
    try {
      server = await selected.gatt?.connect()
      this.check()
      if (connections.get(selected.id) !== this || !server) throw new DOMException("Touch setup cancelled", "AbortError")
      this.server = server
      this.service = await server.getPrimaryService(this.qr.service_uuid)
      this.check()
      for (const characteristic of await this.service.getCharacteristics()) {
        this.check()
        const descriptor = await characteristic.getDescriptor(0x2901)
        const name = new TextDecoder().decode(await descriptor.readValue())
        this.check()
        this.endpoints.set(name, characteristic)
      }
      for (const endpoint of ["prov-session", "prov-scan", "prov-config", "alook-auth"]) if (!this.endpoints.has(endpoint)) throw new Error("Touch setup service is incomplete.")
      selected.addEventListener("gattserverdisconnected", this.disconnected)
      return selected
    } catch (error) {
      if (!connections.has(selected.id) || connections.get(selected.id) === this) server?.disconnect()
      await this.disconnect()
      throw error
    }
  }

  override async writeValue(endpoint: string, data: Uint8Array) {
    this.check()
    if (!this.isConnected) throw new DOMException("Touch setup cancelled", "AbortError")
    try { await super.writeValue(endpoint, data) } catch { this.check(); throw new Error("Touch connection failed.") }
    this.check()
  }

  override async readValue(endpoint: string) {
    this.check()
    if (!this.isConnected) throw new DOMException("Touch setup cancelled", "AbortError")
    let value: Uint8Array
    try { value = await super.readValue(endpoint) } catch { this.check(); throw new Error("Touch connection failed.") }
    this.check()
    return value
  }

  override async disconnect() {
    this.closed = true
    const device = this.device
    device?.removeEventListener("gattserverdisconnected", this.disconnected)
    if (device && connections.get(device.id) === this) {
      connections.delete(device.id)
      if (device.gatt?.connected) device.gatt.disconnect()
    }
    this.device = null; this.server = null; this.service = null; this.endpoints.clear()
  }
}

export function createBrowserTouchSetup(qr: TouchSetupQr, signal: AbortSignal, assertOwner: () => void): TouchSetupTransport {
  const assert = touchSetupGuard(signal, assertOwner)
  const device = new ScopedProvisioner(qr, signal, assertOwner)
  const serial = touchSetupQueue(assert)
  return {
    connect() {
      assert()
      const connection = device.connect().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
      return serial(async () => { const result = await connection; if (!result.ok) throw result.error; assert(); await device.establishSession() })
    },
    scanNetworks: () => serial(async () => {
      const rows = await device.scan()
      const networks = new Map<string, TouchNetwork>()
      for (const row of rows) {
        if (!row.ssid || row.ssid.length > 32) continue
        let ssid: string
        try { ssid = new TextDecoder("utf-8", { fatal: true }).decode(row.ssid) } catch { continue }
        if (!ssid || ssid.includes("\0")) continue
        const network = { ssid, rssi: row.rssi ?? -127, secured: (row.auth ?? 1) !== 0 }
        if (!networks.has(ssid) || network.rssi > networks.get(ssid)!.rssi) networks.set(ssid, network)
      }
      return [...networks.values()].sort((a, b) => b.rssi - a.rssi)
    }),
    provision: (network, password) => serial(async () => {
      const ssidSize = new TextEncoder().encode(network.ssid).length, passwordSize = new TextEncoder().encode(password).length
      if (ssidSize < 1 || ssidSize > 32 || network.ssid.includes("\0") || password.includes("\0") || (network.secured && (passwordSize < 8 || passwordSize > 63))) throw new Error("Check the Wi-Fi password.")
      await device.sendCredentials({ ssid: new TextEncoder().encode(network.ssid), passphrase: new TextEncoder().encode(password) }, 60000)
    }),
    exchangeEndpoint: (action, userCode) => serial(async () => {
      await device.writeValueToEndpoint("alook-auth", new TextEncoder().encode(touchEndpointRequest(action, userCode)))
      assert()
      return parseTouchGrant(await device.readValueFromEndpoint("alook-auth"))
    }),
    cancel: () => device.disconnect(),
  }
}
