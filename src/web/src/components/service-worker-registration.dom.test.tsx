import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServiceWorkerRegistration } from "./service-worker-registration"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { businessDocumentVersionBootstrapScript, CURRENT_DOCUMENT_REQUEST, DOCUMENT_VERSION_PROBE, WORKER_VERSION_PROBE } from "@/lib/service-worker/business-upgrade"
import { WEB_BUILD_ID } from "@/lib/web-build"
import { businessSchemaLifecycle, registerBusinessSchemaOwner } from "@/lib/business-schema-lifecycle"

beforeEach(() => businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION })))

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
  it.each(["/", "/blog", "/blog/article"])("keeps public resource updates on %s outside business retirement", async path => {
    vi.stubEnv("NODE_ENV", "production")
    const worker = { postMessage: vi.fn() }
    const registration = Object.assign(new EventTarget(), { active: worker, update: vi.fn(async () => {}) })
    const container = Object.assign(new EventTarget(), { controller: worker, register: vi.fn(async () => registration) })
    vi.stubGlobal("navigator", { serviceWorker: container })
    const base = window
    vi.stubGlobal("window", new Proxy(base, { get(target, key) {
      return key === "location" ? { href: `https://alook.test${path}`, replace: vi.fn() } : Reflect.get(target, key, target)
    } }))
    const retired = vi.fn(async () => {}), unregister = registerBusinessSchemaOwner(retired)
    try {
      await mount()
      expect(container.register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/", updateViaCache: "none" })
      await act(async () => { window.dispatchEvent(new Event("focus")); container.dispatchEvent(new Event("controllerchange")) })
      await waitFor(() => expect(registration.update).toHaveBeenCalledOnce())
      expect(worker.postMessage).not.toHaveBeenCalled()
      expect(retired).not.toHaveBeenCalled()
      expect(businessSchemaLifecycle.get().phase).toBe("current")
      await act(async () => businessSchemaLifecycle.setState(() => ({ phase: "failed", expectedVersion: BUSINESS_SCHEMA_VERSION })))
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.getByText("Online app content")).toBeVisible()
    } finally { unregister() }
  })

  it.each(["/", "/blog"])("rejects a held business identity after leaving for %s", async path => {
    vi.stubEnv("NODE_ENV", "production")
    let href = "https://alook.test/c/me", reply: MessagePort | undefined
    const requests: string[] = [], closed: Array<ReturnType<typeof vi.spyOn>> = []
    const NativeChannel = MessageChannel
    vi.stubGlobal("MessageChannel", class extends NativeChannel {
      constructor() { super(); closed.push(vi.spyOn(this.port1, "close"), vi.spyOn(this.port2, "close")) }
    })
    const worker = { postMessage: (message: { type: string }, ports: MessagePort[]) => { requests.push(message.type); reply = ports[0] } }
    const registration = Object.assign(new EventTarget(), { active: worker, update: vi.fn(async () => {}) })
    const container = Object.assign(new EventTarget(), { controller: worker, register: vi.fn(async () => registration) })
    vi.stubGlobal("navigator", { serviceWorker: container })
    const base = window
    vi.stubGlobal("window", new Proxy(base, { get(target, key) {
      return key === "location" ? { href, replace: vi.fn() } : Reflect.get(target, key, target)
    } }))
    const retired = vi.fn(async () => {}), unregister = registerBusinessSchemaOwner(retired)
    const view = render(<><ServiceWorkerRegistration /><span>Online app content</span></>)
    try {
      await waitFor(() => expect(reply).toBeDefined())
      expect(closed).toHaveLength(2)
      href = `https://alook.test${path}`
      await act(async () => reply!.postMessage({ schemaVersion: BUSINESS_SCHEMA_VERSION, buildId: "new-main-build" }))
      await waitFor(() => expect(closed.every(close => close.mock.calls.length > 0)).toBe(true))
      expect(requests).toEqual([WORKER_VERSION_PROBE])
      expect(retired).not.toHaveBeenCalled()
      expect(businessSchemaLifecycle.get().phase).toBe("current")
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.getByText("Online app content")).toBeVisible()
      await act(async () => window.dispatchEvent(new Event("focus")))
      await waitFor(() => expect(registration.update).toHaveBeenCalledOnce())
      expect(requests).toEqual([WORKER_VERSION_PROBE])
    } finally { view.unmount(); unregister() }
  })

  it.each(["focus", "pageshow", "visibilitychange"] as const)("checks once on %s and replaces a changed build through the existing lifecycle", async trigger => {
    vi.stubEnv("NODE_ENV", "production")
    let buildId = WEB_BUILD_ID
    const requests: string[] = []
    const worker = { postMessage: (message: { type: string }, ports: MessagePort[]) => {
      requests.push(message.type)
      ports[0]?.postMessage(message.type === WORKER_VERSION_PROBE
        ? { schemaVersion: BUSINESS_SCHEMA_VERSION, buildId } : { navigating: true })
    } }
    const registration = Object.assign(new EventTarget(), { active: worker, waiting: null, installing: null, update: vi.fn(async () => {}) })
    const container = Object.assign(new EventTarget(), { controller: worker, register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration), startMessages: vi.fn() })
    vi.stubGlobal("navigator", { serviceWorker: container })
    const base = window
    vi.stubGlobal("window", new Proxy(base, { get(target, key) {
      return key === "location" ? { href: "https://alook.test/c/me", replace: vi.fn() } : Reflect.get(target, key, target)
    } }))
    sessionStorage.clear()
    const view = render(<ServiceWorkerRegistration />)
    await waitFor(() => expect(requests).toEqual([WORKER_VERSION_PROBE]))
    await act(async () => {
      if (trigger === "visibilitychange") document.dispatchEvent(new Event(trigger))
      else window.dispatchEvent(new Event(trigger))
    })
    await waitFor(() => expect(registration.update).toHaveBeenCalledOnce())
    buildId = "next-build"
    await act(async () => container.dispatchEvent(new Event("controllerchange")))
    await waitFor(() => expect(requests.filter(type => type === CURRENT_DOCUMENT_REQUEST)).toHaveLength(1))
    expect(businessSchemaLifecycle.get()).toMatchObject({ phase: "updating", expectedBuildId: "next-build" })
    new Function("navigator", businessDocumentVersionBootstrapScript)(navigator)
    const reply = vi.fn()
    container.dispatchEvent(new MessageEvent("message", { data: { type: DOCUMENT_VERSION_PROBE }, ports: [{ postMessage: reply } as unknown as MessagePort] }))
    expect(reply).toHaveBeenCalledExactlyOnceWith({ schemaVersion: BUSINESS_SCHEMA_VERSION, buildId: WEB_BUILD_ID })
    view.unmount()
    const count = requests.length
    await act(async () => { window.dispatchEvent(new Event("focus")); container.dispatchEvent(new Event("controllerchange")) })
    expect(requests).toHaveLength(count)
  })
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
    const responder = addListener.mock.calls[0]![1]
    expect(reply).toHaveBeenCalledExactlyOnceWith({ schemaVersion: BUSINESS_SCHEMA_VERSION, buildId: WEB_BUILD_ID })
    expect(container.startMessages).toHaveBeenCalledOnce()
    for (const count of [2, 3]) {
      const view = render(<ServiceWorkerRegistration />)
      view.unmount()
      container.dispatchEvent(event())
      expect(reply).toHaveBeenCalledTimes(count)
      expect(reply).toHaveBeenLastCalledWith({ schemaVersion: BUSINESS_SCHEMA_VERSION, buildId: WEB_BUILD_ID })
    }
    expect(addListener.mock.calls.filter(([type, listener]) => type === "message" && listener === responder)).toHaveLength(1)
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
