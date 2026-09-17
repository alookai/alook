import { fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  isMobile: vi.fn(() => false),
}))

vi.mock("@alook/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@alook/shared")>(),
  isTauri: platform.isTauri,
  isMobile: platform.isMobile,
}))

vi.mock("@next/third-parties/google", () => ({
  GoogleTagManager: ({ gtmId }: { gtmId: string }) => (
    <div data-testid="google-tag-manager" data-gtm-id={gtmId} />
  ),
}))

import { AnalyticsConsent, AnalyticsPreferenceControl } from "./analytics-consent"
import { tid } from "@/lib/community/testids"

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=", 1)[0]?.trim()
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
  }
}

function successfulFetch(decision: "granted" | "denied") {
  return vi.fn(async () => new Response(
    JSON.stringify({ decision }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  ))
}

beforeEach(() => {
  clearCookies()
  platform.isTauri.mockReset().mockReturnValue(false)
  platform.isMobile.mockReset().mockReturnValue(false)
  window.dataLayer = []
})

afterEach(() => {
  clearCookies()
  vi.unstubAllGlobals()
  delete window.dataLayer
})

describe("AnalyticsConsent", () => {
  it("shows a first-visit banner without loading GTM", async () => {
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)
    expect(within(banner).getByText("Analytics, only if you want")).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Only necessary" })).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Allow analytics" })).toBeVisible()
    expect(within(banner).getByTestId(tid.analyticsConsentAvatarCluster).querySelectorAll("svg"))
      .toHaveLength(3)
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
  })

  it("hides the first-visit banner in native mobile clients", async () => {
    platform.isTauri.mockReturnValue(true)
    platform.isMobile.mockReturnValue(true)

    render(<AnalyticsConsent />)

    await waitFor(() => {
      expect(platform.isMobile).toHaveBeenCalled()
    })
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
  })

  it("loads GTM only after the API confirms a grant", async () => {
    const fetcher = successfulFetch("granted")
    vi.stubGlobal("fetch", fetcher)
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)

    fireEvent.click(within(banner).getByRole("button", { name: "Allow analytics" }))

    expect(await screen.findByTestId("google-tag-manager")).toHaveAttribute(
      "data-gtm-id",
      "GTM-56VHCCQZ",
    )
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    expect(window.dataLayer?.[0]).toEqual([
      "consent",
      "default",
      expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" }),
    ])
    expect(fetcher).toHaveBeenCalledWith(
      "/api/privacy/analytics-consent",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ decision: "granted" }),
      }),
    )
  })

  it("stores a denial without loading GTM", async () => {
    vi.stubGlobal("fetch", successfulFetch("denied"))
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)

    fireEvent.click(within(banner).getByRole("button", { name: "Only necessary" }))

    await waitFor(() => {
      expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
  })

  it("honors stored grant and denial choices on mount", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const granted = render(<AnalyticsConsent />)
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    granted.unmount()

    clearCookies()
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    render(<AnalyticsConsent />)
    await waitFor(() => {
      expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
  })

  it("keeps the banner open and explains a save failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )))
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)
    fireEvent.click(within(banner).getByRole("button", { name: "Allow analytics" }))
    expect(await within(banner).findByRole("alert")).toHaveTextContent("Couldn’t save this choice")
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
  })

  it("changes a stored preference from the Privacy control", async () => {
    document.cookie = "alook_analytics_consent=v1.denied; Path=/"
    vi.stubGlobal("fetch", successfulFetch("granted"))
    render(
      <>
        <AnalyticsConsent />
        <AnalyticsPreferenceControl />
      </>,
    )
    const control = await screen.findByTestId(tid.analyticsPreferenceControl)
    expect(within(control).getByText(/Only necessary cookies/u)).toBeVisible()

    fireEvent.click(within(control).getByRole("button", { name: "Allow analytics" }))

    expect(await within(control).findByText(/Optional analytics allowed/u)).toBeVisible()
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(window.dataLayer?.[0]).toEqual([
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" }),
    ])
  })
})
