import { afterEach, beforeEach, expect, it, vi } from "vitest"

const installReactScanMock = vi.fn()
const bootstrapObservabilityMock = vi.fn()
const onObservedRouterTransitionMock = vi.fn()

vi.mock("@/lib/observability/client", () => ({ bootstrapObservability: bootstrapObservabilityMock, onObservedRouterTransition: onObservedRouterTransitionMock }))

vi.mock("@/lib/perf/react-scan-install", () => ({
  installReactScan: installReactScanMock,
}))

beforeEach(() => {
  vi.resetModules()
  installReactScanMock.mockReset().mockResolvedValue(undefined)
  bootstrapObservabilityMock.mockReset()
  onObservedRouterTransitionMock.mockReset()
})

it("starts optional client diagnostics without making app boot await them", async () => {
  let rejectInstall!: (error: Error) => void
  installReactScanMock.mockReturnValue(new Promise<void>((_resolve, reject) => {
    rejectInstall = reject
  }))

  await expect(import("./instrumentation-client")).resolves.toBeDefined()
  expect(installReactScanMock).toHaveBeenCalledOnce()

  rejectInstall(new Error("diagnostics unavailable"))
  await Promise.resolve()
})


afterEach(() => vi.unstubAllGlobals())

it.each(["", "v1.denied", "v0.granted", "v1.granted"])("initializes the real Web entry synchronously from %s before its existing consumers", async cookie => {
  const browser = { location: new URL("https://alook.ai/?secret=query#hash"), dataLayer: [] as unknown[] }
  vi.stubGlobal("window", browser)
  vi.stubGlobal("document", { cookie: `alook_analytics_consent=${cookie}`, referrer: "https://alook.ai/c/me?secret=referrer" })
  bootstrapObservabilityMock.mockImplementation(() => {
    expect(Reflect.get(browser, "ga-disable-G-STBCL8F4ZY")).toBe(false)
    expect(browser.dataLayer.map(command => Array.from(command as IArguments))).toEqual([
      ["consent", "default", { analytics_storage: cookie === "v1.granted" ? "granted" : "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }],
      ["set", { page_location: "https://alook.ai/", page_referrer: "" }],
    ])
    browser.dataLayer.push({ event: "existing-consumer" })
  })
  const entry = await import("./instrumentation-client")
  expect(bootstrapObservabilityMock).toHaveBeenCalledWith("web")
  expect(installReactScanMock).toHaveBeenCalledOnce()
  entry.onRouterTransitionStart("/pricing?secret=route#hash")
  expect(Array.from(browser.dataLayer[3] as IArguments)).toEqual(["set", { page_location: "https://alook.ai/pricing", page_referrer: "" }])
  entry.onRouterTransitionStart("/c/me?secret=private")
  expect(browser.dataLayer).toHaveLength(4)
  expect(onObservedRouterTransitionMock.mock.calls).toEqual([["/pricing?secret=route#hash"], ["/c/me?secret=private"]])
  expect(JSON.stringify(browser.dataLayer)).not.toMatch(/secret|page_view/)
})

it("retains Native diagnostics and router telemetry without the Web bootstrap", async () => {
  const browser = { __TAURI__: {}, location: new URL("https://alook.ai/"), dataLayer: [] as unknown[] }
  vi.stubGlobal("window", browser)
  const entry = await import("./instrumentation-client")
  entry.onRouterTransitionStart("/pricing")
  expect(browser.dataLayer).toEqual([])
  expect(Reflect.has(browser, "ga-disable-G-STBCL8F4ZY")).toBe(false)
  expect(bootstrapObservabilityMock).toHaveBeenCalledWith("web")
  expect(onObservedRouterTransitionMock).toHaveBeenCalledWith("/pricing")
  expect(installReactScanMock).toHaveBeenCalledOnce()
})
