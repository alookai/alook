import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ServiceWorkerRegistration } from "./service-worker-registration"

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
  it("registers the production script with root scope and no HTTP update cache", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const register = vi.fn().mockResolvedValue({})
    vi.stubGlobal("navigator", { serviceWorker: { register } })
    await mount()
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" })
  })

  it("does not install a worker in development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const register = vi.fn()
    vi.stubGlobal("navigator", { serviceWorker: { register } })
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
      ? { serviceWorker: { register: vi.fn().mockRejectedValue(new Error("unavailable")) } }
      : Object.defineProperty({}, "serviceWorker", { get() { throw new Error("denied") } })
    vi.stubGlobal("navigator", navigator)
    await mount()
    expect(warn).toHaveBeenCalledWith("Public asset service worker registration unavailable")
    expect(screen.getByText("Online app content")).toBeVisible()
  })
})
