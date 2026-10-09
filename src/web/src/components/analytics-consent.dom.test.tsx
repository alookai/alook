import { fireEvent, render, screen, waitFor, within } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  isMobile: vi.fn(() => false),
}))

const route = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }))

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
  route.pathname = "/"
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
  it("preserves page layout while the floating banner is open and dismissed", async () => {
    vi.stubGlobal("fetch", successfulFetch("denied"))
    const layoutStyle = document.createElement("style")
    layoutStyle.textContent = `
      body { padding-bottom: 0px; }
      .hero-section, .workspace-shell { height: 100dvh; }
    `
    document.head.appendChild(layoutStyle)
    try {
      render(
        <>
          <main className="hero-section" data-testid="consent-hero" />
          <main className="workspace-shell" data-testid="consent-workspace" />
          <AnalyticsConsent />
        </>,
      )
      const banner = await screen.findByTestId(tid.analyticsConsentBanner)
      const expectPageLayout = () => {
        expect(getComputedStyle(document.body).paddingBottom).toBe("0px")
        expect(getComputedStyle(screen.getByTestId("consent-hero")).height).toBe("100dvh")
        expect(getComputedStyle(screen.getByTestId("consent-workspace")).height).toBe("100dvh")
      }
      expectPageLayout()
      fireEvent(window, new Event("resize"))
      expectPageLayout()
      fireEvent.click(within(banner).getByRole("button", { name: "Only necessary" }))
      await waitFor(() => {
        expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
      })
      expectPageLayout()
    } finally {
      layoutStyle.remove()
    }
  })

  it("shows a first-visit banner without loading GTM", async () => {
    render(<AnalyticsConsent />)
    const banner = await screen.findByTestId(tid.analyticsConsentBanner)
    expect(within(banner).getByText("Analytics, only if you want")).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Only necessary" })).toBeVisible()
    expect(within(banner).getByRole("button", { name: "Allow analytics" })).toBeVisible()
    expect(within(banner).getByTestId(tid.analyticsConsentAvatarCluster).querySelectorAll("svg"))
      .toHaveLength(3)
    expect(screen.queryByTestId("google-tag-manager")).not.toBeInTheDocument()
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
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
    expect(await screen.findByTestId(tid.ahrefsAnalyticsFrame)).toHaveAttribute("sandbox", "allow-scripts")
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
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
  })

  it("honors stored grant and denial choices on mount", async () => {
    document.cookie = "alook_analytics_consent=v1.granted; Path=/"
    const granted = render(<AnalyticsConsent />)
    expect(await screen.findByTestId("google-tag-manager")).toBeInTheDocument()
    expect(screen.queryByTestId(tid.analyticsConsentBanner)).not.toBeInTheDocument()
    const home = screen.getByTestId(tid.ahrefsAnalyticsFrame)
    for (const pathname of ["/c", "/c/me", "/c/channels/private/channel", "/sign-in", "/auth/callback"]) {
      route.pathname = pathname
      granted.rerender(<AnalyticsConsent />)
      expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
    }
    route.pathname = "/pricing"
    granted.rerender(<AnalyticsConsent />)
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame)).not.toBe(home)
    expect(screen.getByTestId(tid.ahrefsAnalyticsFrame).getAttribute("srcdoc"))
      .toContain(`data-page-location="${window.location.origin}/pricing"`)
    fireEvent(window, new CustomEvent("alook:analytics-consent-change", { detail: "denied" }))
    await waitFor(() => expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument())
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
    expect(screen.queryByTestId(tid.ahrefsAnalyticsFrame)).not.toBeInTheDocument()
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
