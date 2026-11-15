import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { browserInterfaceAngle, coarseDeviceAngle, deviceAngleFromTilt, listenBrowserDeviceOrientation, createDeviceOrientationService } from "./device-orientation"

const state = vi.hoisted(() => ({ native: false, platform: "mobile", nativeListen: vi.fn(), lifecycle: vi.fn() }))
vi.mock("@alook/shared", () => ({ isTauri: () => state.native, getClientPlatform: () => state.platform }))
vi.mock("./native-device-orientation", async original => ({ ...await original<typeof import("./native-device-orientation")>(), listenNativeDeviceOrientation: state.nativeListen }))
vi.mock("./native-window-lifecycle", () => ({ listenNativeWindowLifecycle: state.lifecycle }))

let host: EventTarget & { isSecureContext: boolean; DeviceOrientationEvent: { requestPermission?: (absolute?: boolean) => Promise<PermissionState> }; screen: { orientation: EventTarget & { angle: number } }; orientation?: number }
let page: EventTarget & { hidden: boolean }
const right = { availability: "available", physicalAngle: 90 as const, interfaceAngle: 0 as const }
beforeEach(() => {
  host = Object.assign(new EventTarget(), { isSecureContext: true, DeviceOrientationEvent: {}, screen: { orientation: Object.assign(new EventTarget(), { angle: 0 }) } })
  page = Object.assign(new EventTarget(), { hidden: false })
  vi.stubGlobal("window", host)
  vi.stubGlobal("document", page)
  state.native = false
  state.platform = "mobile"
  state.nativeListen.mockReset()
  state.lifecycle.mockReset().mockReturnValue(() => undefined)
})
afterEach(() => vi.unstubAllGlobals())
const tilt = (beta: number | null, gamma: number | null) => host.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma }))

describe("physical direction from browser tilt", () => {
  it("derives all four directions from gravity instead of using the page direction", () => {
    expect(deviceAngleFromTilt(90, 0, null)).toBe(0)
    expect(deviceAngleFromTilt(0, 89, null)).toBe(90)
    expect(deviceAngleFromTilt(-90, 0, null)).toBe(180)
    expect(deviceAngleFromTilt(0, -89, null)).toBe(270)
    expect(deviceAngleFromTilt(80, 50, null)).toBe(0)
  })
  it("retains the last valid direction for flat, missing or invalid samples and uses hysteresis", () => {
    expect(deviceAngleFromTilt(0, 0, null)).toBeNull()
    expect(deviceAngleFromTilt(0, 0, 90)).toBe(90)
    expect(deviceAngleFromTilt(null, 0, 270)).toBe(270)
    expect(deviceAngleFromTilt(NaN, 30, 0)).toBe(0)
    expect(deviceAngleFromTilt(181, 0, 90)).toBe(90)
    expect(deviceAngleFromTilt(0, 90, 270)).toBe(270)
    expect(coarseDeviceAngle(59, 0)).toBe(0)
    expect(coarseDeviceAngle(61, 0)).toBe(90)
    expect(coarseDeviceAngle(39, 90)).toBe(90)
    expect(coarseDeviceAngle(29, 90)).toBe(0)
    expect(coarseDeviceAngle(359, 0)).toBe(0)
  })
  it("converts screen compensation angles and rejects a missing interface-angle capability", () => {
    host.screen.orientation.angle = 90
    expect(browserInterfaceAngle()).toBe(270)
    host.screen.orientation.angle = 270
    expect(browserInterfaceAngle()).toBe(90)
    Reflect.deleteProperty(host.screen, "orientation")
    expect(browserInterfaceAngle()).toBeNull()
  })
  it("requests needed permission synchronously from the expansion gesture without compass access", async () => {
    let resolve!: (value: PermissionState) => void
    const request = vi.fn(() => new Promise<PermissionState>(done => { resolve = done }))
    host.DeviceOrientationEvent.requestPermission = request
    const permission = createDeviceOrientationService().requestPermission()
    expect(request).toHaveBeenCalledWith(false)
    resolve("granted")
    expect(await permission).toBe(true)
  })
  it("leaves denied, insecure, missing and desktop providers inactive", async () => {
    host.DeviceOrientationEvent.requestPermission = vi.fn().mockResolvedValue("denied")
    expect(await createDeviceOrientationService().requestPermission()).toBe(false)
    host.DeviceOrientationEvent.requestPermission = vi.fn(() => { throw new Error("gesture missing") })
    expect(await createDeviceOrientationService().requestPermission()).toBe(false)
    host.isSecureContext = false
    expect(await createDeviceOrientationService().requestPermission()).toBe(false)
    expect(host.DeviceOrientationEvent.requestPermission).toHaveBeenCalledOnce()
    host.isSecureContext = true
    Reflect.deleteProperty(host, "DeviceOrientationEvent")
    expect(await createDeviceOrientationService().requestPermission()).toBe(false)
    host.DeviceOrientationEvent = {}
    state.platform = "desktop"
    expect(await createDeviceOrientationService().requestPermission()).toBe(false)
    state.platform = "mobile"; state.native = true
    expect(await createDeviceOrientationService().requestPermission()).toBe(true)
  })
  it("updates on real event delivery and interface changes, then removes every listener", () => {
    const changed = vi.fn()
    const stop = listenBrowserDeviceOrientation(changed)
    tilt(0, 89)
    expect(changed).toHaveBeenLastCalledWith(right)
    host.screen.orientation.angle = 270
    host.screen.orientation.dispatchEvent(new Event("change"))
    expect(changed).toHaveBeenLastCalledWith({ ...right, interfaceAngle: 90 })
    tilt(0, 0)
    expect(changed).toHaveBeenLastCalledWith({ ...right, interfaceAngle: 90 })
    const count = changed.mock.calls.length
    stop()
    tilt(0, -89)
    host.dispatchEvent(new Event("orientationchange"))
    host.screen.orientation.dispatchEvent(new Event("change"))
    expect(changed).toHaveBeenCalledTimes(count)
  })
})

describe("shared physical direction capability", () => {
  it("waits for permission and visibility, retires hidden deliveries and stops on disposal", async () => {
    const changed = vi.fn()
    let resolve!: (allowed: boolean) => void
    const service = createDeviceOrientationService()
    host.DeviceOrientationEvent.requestPermission = () => new Promise<PermissionState>(done => { resolve = allowed => done(allowed ? "granted" : "denied") })
    const requested = service.requestPermission()
    const stop = service.subscribe(() => changed(service.getSnapshot()))
    tilt(0, 89)
    expect(changed).not.toHaveBeenCalled()
    page.hidden = true
    page.dispatchEvent(new Event("visibilitychange"))
    resolve(true)
    await requested
    tilt(0, 89)
    expect(changed).not.toHaveBeenCalled()
    page.hidden = false
    page.dispatchEvent(new Event("visibilitychange"))
    tilt(0, 89)
    expect(changed).toHaveBeenCalledWith(right)
    host.dispatchEvent(new Event("pagehide"))
    tilt(0, -89)
    expect(service.getSnapshot().availability).toBe("unavailable")
    const hiddenCount = changed.mock.calls.length
    host.dispatchEvent(new Event("pageshow"))
    tilt(0, -89)
    expect(service.getSnapshot()).toEqual({ ...right, physicalAngle: 270 })
    expect(changed.mock.calls.length).toBeGreaterThan(hiddenCount)
    const count = changed.mock.calls.length
    stop()
    page.dispatchEvent(new Event("visibilitychange"))
    tilt(90, 0)
    expect(changed).toHaveBeenCalledTimes(count)
  })
  it("binds native callbacks to one foreground generation and never revives a disposed request", async () => {
    state.native = true
    const callbacks: Array<(value: typeof right) => void> = []
    const release = vi.fn()
    state.nativeListen.mockImplementation(callback => { callbacks.push(callback); return release })
    const changed = vi.fn()
    const service = createDeviceOrientationService()
    await service.requestPermission()
    const stop = service.subscribe(() => changed(service.getSnapshot()))
    callbacks[0]!(right)
    const lifecycle = state.lifecycle.mock.calls[0]![0] as { suspended: () => void; resumed: () => void }
    lifecycle.suspended()
    callbacks[0]!(right)
    expect(service.getSnapshot().availability).toBe("unavailable")
    expect(release).toHaveBeenCalledOnce()
    const suspendedCount = changed.mock.calls.length
    lifecycle.resumed()
    callbacks[1]!(right)
    expect(changed).toHaveBeenCalledTimes(suspendedCount + 1)
    const count = changed.mock.calls.length
    stop()
    lifecycle.resumed()
    callbacks[1]!(right)
    expect(changed).toHaveBeenCalledTimes(count)
    expect(state.nativeListen).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
  })
  it("does not attach after late permission or denial", async () => {
    let resolve!: (allowed: PermissionState) => void
    host.DeviceOrientationEvent.requestPermission = () => new Promise<PermissionState>(done => { resolve = done })
    const service = createDeviceOrientationService()
    const requested = service.requestPermission()
    const changed = vi.fn()
    const stop = service.subscribe(changed)
    stop()
    resolve("granted")
    await requested
    tilt(0, 89)
    expect(changed).not.toHaveBeenCalled()
    host.DeviceOrientationEvent.requestPermission = async () => "denied"
    const denied = createDeviceOrientationService()
    const release = denied.subscribe(changed)
    expect(await denied.requestPermission()).toBe(false)
    expect(denied.getSnapshot().availability).toBe("denied")
    expect(changed).toHaveBeenCalledOnce()
    tilt(0, 89)
    expect(changed).toHaveBeenCalledOnce()
    release()
  })
  it("shares one permission request and native producer until the last consumer leaves", async () => {
    state.native = true
    const callbacks: Array<(value: typeof right) => void> = []
    const release = vi.fn()
    state.nativeListen.mockImplementation(callback => { callbacks.push(callback); return release })
    const service = createDeviceOrientationService()
    const first = vi.fn(), second = vi.fn()
    const permission = service.requestPermission()
    expect(service.requestPermission()).toBe(permission)
    const leaveFirst = service.subscribe(first)
    const leaveSecond = service.subscribe(second)
    await permission
    expect(state.nativeListen).toHaveBeenCalledOnce()
    callbacks[0]!(right)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    leaveFirst()
    expect(release).not.toHaveBeenCalled()
    callbacks[0]!({ ...right, interfaceAngle: 90 } as typeof right)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledTimes(2)
    leaveSecond()
    expect(release).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toEqual({ availability: "unavailable", physicalAngle: null, interfaceAngle: 0 })
    const rejoin = service.subscribe(first)
    expect(state.nativeListen).toHaveBeenCalledTimes(2)
    callbacks[0]!(right)
    expect(first).toHaveBeenCalledOnce()
    rejoin()
  })
  it("counts registrations independently even when callbacks are identical", async () => {
    const service = createDeviceOrientationService()
    await service.requestPermission()
    const notify = vi.fn()
    const leaveFirst = service.subscribe(notify)
    const leaveSecond = service.subscribe(notify)
    leaveFirst()
    leaveFirst()
    tilt(0, 89)
    expect(notify).toHaveBeenCalledOnce()
    leaveSecond()
    tilt(0, -89)
    expect(notify).toHaveBeenCalledOnce()
  })
  it("distinguishes denied browser permission from unavailable hardware without sampling", async () => {
    const add = vi.spyOn(host, "addEventListener")
    host.DeviceOrientationEvent.requestPermission = async () => "denied"
    const denied = createDeviceOrientationService()
    const leave = denied.subscribe(vi.fn())
    expect(await denied.requestPermission()).toBe(false)
    expect(denied.getSnapshot().availability).toBe("denied")
    page.dispatchEvent(new Event("visibilitychange"))
    host.dispatchEvent(new Event("pageshow"))
    expect(add.mock.calls.some(([name]) => name === "deviceorientation")).toBe(false)
    expect(denied.getSnapshot().availability).toBe("denied")
    leave()
    host.isSecureContext = false
    const unavailable = createDeviceOrientationService()
    expect(await unavailable.requestPermission()).toBe(false)
    expect(unavailable.getSnapshot().availability).toBe("unavailable")
  })
  it("stops a denied native producer for every consumer and does not restart on foreground", async () => {
    state.native = true
    const callbacks: Array<(value: { availability: string; physicalAngle: 90; interfaceAngle: 0 }) => void> = []
    const release = vi.fn()
    state.nativeListen.mockImplementation(callback => { callbacks.push(callback); return release })
    const service = createDeviceOrientationService()
    await service.requestPermission()
    const first = vi.fn(), second = vi.fn()
    const leaveFirst = service.subscribe(first), leaveSecond = service.subscribe(second)
    callbacks[0]!(right)
    callbacks[0]!({ ...right, availability: "denied" })
    expect(service.getSnapshot()).toEqual({ ...right, availability: "denied" })
    expect(release).toHaveBeenCalledOnce()
    const lifecycle = state.lifecycle.mock.calls[0]![0] as { resumed: () => void }
    lifecycle.resumed()
    page.dispatchEvent(new Event("visibilitychange"))
    const third = service.subscribe(vi.fn())
    expect(state.nativeListen).toHaveBeenCalledOnce()
    callbacks[0]!(right)
    expect(service.getSnapshot().availability).toBe("denied")
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    leaveFirst(); leaveSecond(); third()
    expect(release).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toEqual({ availability: "denied", physicalAngle: null, interfaceAngle: 0 })
    const rejoin = service.subscribe(vi.fn())
    expect(state.nativeListen).toHaveBeenCalledOnce()
    expect(service.getSnapshot().availability).toBe("denied")
    rejoin()
  })
  it("cleans up a producer that reports denial synchronously during attachment", async () => {
    state.native = true
    const release = vi.fn()
    state.nativeListen.mockImplementation(callback => { callback({ ...right, availability: "denied" }); return release })
    const service = createDeviceOrientationService()
    await service.requestPermission()
    const leave = service.subscribe(vi.fn())
    expect(service.getSnapshot().availability).toBe("denied")
    expect(release).toHaveBeenCalledOnce()
    leave()
    expect(release).toHaveBeenCalledOnce()
  })

})
