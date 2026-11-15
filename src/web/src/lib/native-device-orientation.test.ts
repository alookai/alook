import { afterEach, describe, expect, it, vi } from "vitest"
import { listenNativeDeviceOrientation, parseDeviceDirection } from "./native-device-orientation"

const invoke = vi.hoisted(() => vi.fn())
vi.mock("@alook/shared", () => ({ tauriInvoke: invoke }))
afterEach(() => { vi.unstubAllGlobals(); invoke.mockReset() })

function bridge() {
  const channels: Array<{ onmessage: (value: unknown) => void }> = []
  class Channel {
    onmessage = (_value: unknown) => undefined
    constructor() { channels.push(this) }
  }
  vi.stubGlobal("window", { __TAURI__: { core: { Channel } } })
  return channels
}

const right = { availability: "available", physicalAngle: 90, interfaceAngle: 0 }
describe("native physical direction subscription", () => {
  it("admits coarse native samples and preserves explicit unavailable/unknown states", () => {
    expect(parseDeviceDirection(right)).toEqual(right)
    expect(parseDeviceDirection({ availability: "unavailable", physicalAngle: null, interfaceAngle: 270 })).not.toBeNull()
    for (const value of [null, [], { ...right, physicalAngle: 91 }, { ...right, interfaceAngle: -90 }, { ...right, availability: "yes" }, { physicalAngle: 0 }]) {
      expect(parseDeviceDirection(value)).toBeNull()
    }
  })
  it("releases a pending registration after disposal and suppresses all late delivery", async () => {
    const channels = bridge()
    let resolve!: (id: number) => void
    invoke.mockImplementation((command: string) => command.endsWith("_listen") ? new Promise<number>(done => { resolve = done }) : Promise.resolve())
    const changed = vi.fn()
    const stop = listenNativeDeviceOrientation(changed)
    channels[0]!.onmessage(right)
    expect(changed).toHaveBeenCalledOnce()
    stop()
    channels[0]!.onmessage(right)
    resolve(42)
    await Promise.resolve()
    expect(changed).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenLastCalledWith("mobile_orientation_unlisten", { registrationId: 42 })
  })
  it("keeps cleanup bound to each subscription instead of its replacement", async () => {
    const channels = bridge()
    invoke.mockResolvedValueOnce(11).mockResolvedValueOnce(12).mockResolvedValue(undefined)
    const first = vi.fn(), second = vi.fn()
    const stopFirst = listenNativeDeviceOrientation(first)
    const stopSecond = listenNativeDeviceOrientation(second)
    await Promise.resolve()
    stopFirst()
    expect(invoke).toHaveBeenLastCalledWith("mobile_orientation_unlisten", { registrationId: 11 })
    channels[0]!.onmessage(right)
    channels[1]!.onmessage(right)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(right)
    stopSecond()
    expect(invoke).toHaveBeenLastCalledWith("mobile_orientation_unlisten", { registrationId: 12 })
  })
  it("contains bridge rejection and ignores malformed events without publishing a pose", async () => {
    const channels = bridge()
    invoke.mockRejectedValue(new Error("unsupported"))
    const changed = vi.fn()
    const stop = listenNativeDeviceOrientation(changed)
    channels[0]!.onmessage({ ...right, physicalAngle: 14 })
    await Promise.resolve()
    channels[0]!.onmessage(right)
    stop()
    expect(changed).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledOnce()
  })
})
