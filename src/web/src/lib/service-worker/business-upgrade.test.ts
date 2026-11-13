import { afterEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { businessDocumentVersionBootstrapScript, businessUpdateUrl, DOCUMENT_UPDATE_AVAILABLE, probeBusinessIdentity, probeBusinessVersion, upgradeBusinessWindow } from "./business-upgrade"
import { WEB_BUILD_ID } from "../web-build"

afterEach(() => vi.useRealTimers())

function client(version?: number, url = "https://alook.test/c/me", buildId: string | null = version === BUSINESS_SCHEMA_VERSION ? WEB_BUILD_ID : null) {
  return {
    url,
    navigate: vi.fn().mockResolvedValue({}),
    postMessage: vi.fn((_message: unknown, ports: MessagePort[]) => {
      if (version !== undefined) ports[0]?.postMessage({ schemaVersion: version, ...(buildId ? { buildId } : {}) })
    }),
  } as unknown as WindowClient
}

describe("business document replacement", () => {
  it.each(["before-probe", "queued-before-bootstrap"])("keeps the current document with its actual bootstrap %s", async timing => {
    const container = new EventTarget()
    const pending: MessageEvent[] = []
    let started = false
    const startMessages = vi.fn(() => {
      started = true
      for (const event of pending.splice(0)) container.dispatchEvent(event)
    })
    const navigator = { serviceWorker: Object.assign(container, { startMessages }) }
    const install = () => new Function("navigator", businessDocumentVersionBootstrapScript)(navigator)
    const target = {
      url: "https://alook.test/c/me", navigate: vi.fn().mockResolvedValue({}),
      postMessage: (data: unknown, ports: MessagePort[]) => {
        const event = new MessageEvent("message", { data, ports })
        if (started) container.dispatchEvent(event)
        else pending.push(event)
      },
    } as unknown as WindowClient
    if (timing === "before-probe") install()
    const upgrading = upgradeBusinessWindow(target, "https://alook.test")
    if (timing === "queued-before-bootstrap") {
      expect(pending).toHaveLength(1)
      install()
    }
    expect(await upgrading).toBe(false)
    expect(startMessages).toHaveBeenCalledOnce()
    expect(target.navigate).not.toHaveBeenCalled()
  })

  it("keeps a document that actually confirms the current compiled version", async () => {
    const current = client(BUSINESS_SCHEMA_VERSION)
    expect(await upgradeBusinessWindow(current, "https://alook.test")).toBe(false)
    expect(current.postMessage).toHaveBeenCalledTimes(1)
    expect(current.navigate).not.toHaveBeenCalled()
  })

  it("replaces a mismatched document and carries its version attempt marker", async () => {
    const old = client(BUSINESS_SCHEMA_VERSION - 1)
    expect(await upgradeBusinessWindow(old, "https://alook.test")).toBe(true)
    expect(old.navigate).toHaveBeenCalledWith(businessUpdateUrl("https://alook.test/c/me", BUSINESS_SCHEMA_VERSION, WEB_BUILD_ID))
  })

  it("bounds a missing old-page listener and replaces that document once", async () => {
    vi.useFakeTimers()
    const old = client()
    const upgrade = upgradeBusinessWindow(old, "https://alook.test")
    await vi.advanceTimersByTimeAsync(1500)
    expect(await upgrade).toBe(true)
    const attempted = client(undefined, businessUpdateUrl("https://alook.test/c/me", BUSINESS_SCHEMA_VERSION, WEB_BUILD_ID)!)
    const again = upgradeBusinessWindow(attempted, "https://alook.test")
    await vi.advanceTimersByTimeAsync(1500)
    expect(await again).toBe(false)
    expect(attempted.navigate).not.toHaveBeenCalled()
  })

  it("updates the actual public invite entry without routing it through a private shell", async () => {
    const page = client(BUSINESS_SCHEMA_VERSION - 1, "https://alook.test/c/invite/token")
    expect(await upgradeBusinessWindow(page, "https://alook.test")).toBe(true)
    expect(page.navigate).toHaveBeenCalledWith(businessUpdateUrl("https://alook.test/c/invite/token", BUSINESS_SCHEMA_VERSION, WEB_BUILD_ID))
    const attempted = client(BUSINESS_SCHEMA_VERSION, `https://alook.test/c/invite/token?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}`)
    expect(await upgradeBusinessWindow(attempted, "https://alook.test", true, true)).toBe(true)
  })

  it("does not navigate another origin or a public page", async () => {
    for (const url of ["https://other.test/c/me", "https://alook.test/sign-in"]) {
      const page = client(undefined, url)
      expect(await upgradeBusinessWindow(page, "https://alook.test", true)).toBe(false)
      expect(page.postMessage).not.toHaveBeenCalled()
      expect(page.navigate).not.toHaveBeenCalled()
    }
    expect(businessUpdateUrl("https://alook.test/", BUSINESS_SCHEMA_VERSION)).toBeNull()
  })

  it("treats an invalid reply as missing version without accepting a shape", async () => {
    const target = { postMessage: (_message: unknown, ports: Transferable[]) => (ports[0] as MessagePort).postMessage({ schemaVersion: "old" }) }
    expect(await probeBusinessVersion(target, "probe")).toBeNull()
  })

  it("classifies a legacy schema-only current reply as stale and replaces it once", async () => {
    const legacy = client(BUSINESS_SCHEMA_VERSION, "https://alook.test/c/me", null)
    expect(await probeBusinessIdentity(legacy, "probe")).toEqual({ schemaVersion: BUSINESS_SCHEMA_VERSION })
    expect(await upgradeBusinessWindow(legacy, "https://alook.test")).toBe(true)
    expect(legacy.navigate).toHaveBeenCalledWith(businessUpdateUrl(legacy.url, BUSINESS_SCHEMA_VERSION, WEB_BUILD_ID))
  })

  it("notifies a same-protocol different build to retire its own page before forced navigation", async () => {
    const previous = client(BUSINESS_SCHEMA_VERSION, "https://alook.test/c/me", "old-build")
    expect(await upgradeBusinessWindow(previous, "https://alook.test")).toBe(false)
    expect(previous.navigate).not.toHaveBeenCalled()
    expect(previous.postMessage).toHaveBeenLastCalledWith({ type: DOCUMENT_UPDATE_AVAILABLE }, [])
    expect(await upgradeBusinessWindow(previous, "https://alook.test", true)).toBe(true)
    expect(previous.navigate).toHaveBeenCalledOnce()
  })

  it("keys attempts by opaque build equality instead of protocol or lexical ordering", () => {
    const first = businessUpdateUrl("https://alook.test/c/me?keep=1#target", BUSINESS_SCHEMA_VERSION, "z-build")!
    expect(businessUpdateUrl(first, BUSINESS_SCHEMA_VERSION, "z-build")).toBeNull()
    const later = businessUpdateUrl(first, BUSINESS_SCHEMA_VERSION, "a-build")!
    expect(new URL(later).searchParams.get("keep")).toBe("1")
    expect(new URL(later).hash).toBe("#target")
    expect(new URL(later).searchParams.get("__alook_schema_update")).toBe(`${BUSINESS_SCHEMA_VERSION}:a-build`)
  })
})
