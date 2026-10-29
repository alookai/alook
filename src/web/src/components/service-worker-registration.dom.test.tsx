import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ServiceWorkerRegistration } from "./service-worker-registration"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { businessDocumentVersionBootstrapScript, DOCUMENT_VERSION_PROBE } from "@/lib/service-worker/business-upgrade"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount() {
  await act(async () => {
    render(<><ServiceWorkerRegistration /><span>Online app content</span></>)
  })
}

describe("public asset service worker registration", () => {
  it("answers before React mounts and retains one document responder across component remounts", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const reply = vi.fn()
    const event = () => new MessageEvent("message", { data: { type: DOCUMENT_VERSION_PROBE }, ports: [{ postMessage: reply } as unknown as MessagePort] })
    const container = Object.assign(new EventTarget(), {
      register: vi.fn().mockResolvedValue({}),
      startMessages: vi.fn((): void => { container.dispatchEvent(event()) }),
    })
    const addListener = vi.spyOn(container, "addEventListener")
    vi.stubGlobal("navigator", { serviceWorker: container })
    new Function("navigator", businessDocumentVersionBootstrapScript)(navigator)
    expect(reply).toHaveBeenCalledExactlyOnceWith({ schemaVersion: BUSINESS_SCHEMA_VERSION })
    expect(container.startMessages).toHaveBeenCalledOnce()
    for (const count of [2, 3]) {
      const view = render(<ServiceWorkerRegistration />)
      view.unmount()
      container.dispatchEvent(event())
      expect(reply).toHaveBeenCalledTimes(count)
      expect(reply).toHaveBeenLastCalledWith({ schemaVersion: BUSINESS_SCHEMA_VERSION })
    }
    expect(addListener).toHaveBeenCalledOnce()
    expect(addListener).toHaveBeenCalledWith("message", expect.any(Function))
    expect(container.register).toHaveBeenCalledTimes(2)
  })

  it("ignores unrelated messages and safely receives a probe without a response port", () => {
    const container = Object.assign(new EventTarget(), { startMessages: vi.fn() })
    vi.stubGlobal("navigator", { serviceWorker: container })
    new Function("navigator", businessDocumentVersionBootstrapScript)(navigator)
    const reply = vi.fn()
    container.dispatchEvent(new MessageEvent("message", { data: { type: "unrelated" }, ports: [{ postMessage: reply } as unknown as MessagePort] }))
    expect(reply).not.toHaveBeenCalled()
    expect(() => container.dispatchEvent(new MessageEvent("message", { data: { type: DOCUMENT_VERSION_PROBE } }))).not.toThrow()
  })

  it.each(["unsupported", "security getter", "start failure"])("keeps the page usable when bootstrap meets %s", async failure => {
    vi.stubEnv("NODE_ENV", "production")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const value = failure === "unsupported" ? {} : failure === "security getter"
      ? Object.defineProperty({}, "serviceWorker", { get() { throw new Error("denied") } })
      : { serviceWorker: Object.assign(new EventTarget(), { startMessages() { throw new Error("unavailable") }, register: vi.fn().mockResolvedValue({}) }) }
    vi.stubGlobal("navigator", value)
    expect(() => new Function("navigator", businessDocumentVersionBootstrapScript)(navigator)).not.toThrow()
    await mount()
    expect(screen.getByText("Online app content")).toBeVisible()
  })

  it("registers the production script with root scope and no HTTP update cache", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const register = vi.fn().mockResolvedValue({})
    vi.stubGlobal("navigator", { serviceWorker: Object.assign(new EventTarget(), { register }) })
    await mount()
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" })
  })

  it("does not install a worker in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const register = vi.fn()
    vi.stubGlobal("navigator", { serviceWorker: Object.assign(new EventTarget(), { register }) })
    await mount()
    expect(register).not.toHaveBeenCalled()
  })

  it("keeps rendering when service workers are unsupported", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubGlobal("navigator", {})
    await mount()
    expect(screen.getByText("Online app content")).toBeVisible()
  })

  it.each(["rejection", "security getter"])("keeps the online app after a %s failure", async failure => {
    vi.stubEnv("NODE_ENV", "production")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const navigator = failure === "rejection"
      ? { serviceWorker: Object.assign(new EventTarget(), { register: vi.fn().mockRejectedValue(new Error("unavailable")) }) }
      : Object.defineProperty({}, "serviceWorker", { get() { throw new Error("denied") } })
    vi.stubGlobal("navigator", navigator)
    await mount()
    expect(warn).toHaveBeenCalledWith("Public asset service worker registration unavailable")
    expect(screen.getByText("Online app content")).toBeVisible()
  })
})
