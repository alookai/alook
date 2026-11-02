import { afterEach, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { DOWNLOAD_TARGETS, IOS_TESTFLIGHT_URL, type DownloadEnvironment } from "@/lib/download-platforms"
import { DownloadCurrentPlatform } from "./download-current-platform"

const installers = DOWNLOAD_TARGETS.map(target => ({ id: target.id, version: "1.0.0", bytes: 1000, url: `https://github.com/alookai/alook/releases/download/v1.0.0/${target.id}` }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function hints(value: unknown) {
  Object.defineProperty(navigator, "userAgentData", { configurable: true, value })
}
afterEach(() => { hints(undefined); Reflect.deleteProperty(navigator, "maxTouchPoints") })

it.each([
  ["windows", "x64", "Windows", "windows-exe"],
  ["linux", "x64", "Linux", "linux-appimage"],
  ["android", "unknown", "Android", "android-apk"],
] as const)("directly links the real %s installer on the first screen", (platform, architecture, label, id) => {
  render(<DownloadCurrentPlatform installers={installers} initialEnvironment={{ platform, architecture }} />)
  expect(screen.getByRole("link", { name: `Download for ${label}` })).toHaveAttribute("href", installers.find(item => item.id === id)!.url)
})

it("keeps two direct Mac chip choices when Client Hints is unavailable or denied", async () => {
  hints({ platform: "macOS", getHighEntropyValues: vi.fn().mockRejectedValue(new Error("denied")) })
  render(<DownloadCurrentPlatform installers={installers} initialEnvironment={{ platform: "macos", architecture: "unknown" }} />)
  await act(async () => {})
  expect(screen.getByRole("link", { name: /Apple Silicon/ })).toHaveAttribute("href", installers[0].url)
  expect(screen.getByRole("link", { name: /Intel/ })).toHaveAttribute("href", installers[1].url)
})

it.each([["arm", "mac-arm"], ["x86", "mac-intel"]] as const)("uses native 64-bit %s Client Hints for a single direct Mac download", async (architecture, id) => {
  const getHighEntropyValues = vi.fn().mockResolvedValue({ architecture, bitness: "64" })
  hints({ platform: "macOS", getHighEntropyValues })
  render(<DownloadCurrentPlatform installers={installers} initialEnvironment={{ platform: "macos", architecture: "unknown" }} />)
  await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(1))
  expect(screen.getByRole("link", { name: "Download for Mac" })).toHaveAttribute("href", installers.find(item => item.id === id)!.url)
  expect(getHighEntropyValues).toHaveBeenCalledWith(["architecture", "bitness"])
})

it("falls back to the real MSI if the current release has no EXE", () => {
  render(<DownloadCurrentPlatform installers={installers.filter(item => item.id !== "windows-exe")} initialEnvironment={{ platform: "windows", architecture: "x64" }} />)
  expect(screen.getByRole("link", { name: "Download for Windows" })).toHaveAttribute("href", installers[3].url)
})

it.each([
  { platform: "unknown", architecture: "unknown" },
  { platform: "windows", architecture: "arm64" },
  { platform: "linux", architecture: "unsupported" },
] satisfies DownloadEnvironment[])("keeps manual platforms available for %j", initialEnvironment => {
  render(<DownloadCurrentPlatform installers={installers} initialEnvironment={initialEnvironment} />)
  expect(screen.getByRole("link", { name: "Choose your platform" })).toHaveAttribute("href", "#desktop")
})

it("never invents a URL when the catalog failed", () => {
  render(<DownloadCurrentPlatform installers={[]} initialEnvironment={{ platform: "macos", architecture: "unknown" }} />)
  expect(screen.getAllByRole("link")).toHaveLength(1)
  expect(screen.getByRole("link")).toHaveAttribute("href", "#desktop")
})

it("recognizes an iPad's desktop-mode Mac fallback without offering a Mac DMG", () => {
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 })
  render(<DownloadCurrentPlatform installers={installers} initialEnvironment={{ platform: "macos", architecture: "unknown" }} />)
  expect(screen.getByRole("link", { name: "Join the beta" })).toHaveAttribute("href", IOS_TESTFLIGHT_URL)
  expect(screen.queryByRole("link", { name: /Download for Mac/ })).toBeNull()
})

it("retires a pending hints response before it can change a newer environment", async () => {
  let resolve!: (value: { architecture: string; bitness: string }) => void
  hints({ platform: "macOS", getHighEntropyValues: () => new Promise(done => { resolve = done }) })
  const view = render(<DownloadCurrentPlatform installers={installers} initialEnvironment={{ platform: "macos", architecture: "unknown" }} />)
  hints(undefined)
  view.rerender(<DownloadCurrentPlatform installers={installers} initialEnvironment={{ platform: "windows", architecture: "x64" }} />)
  await act(async () => resolve({ architecture: "arm", bitness: "64" }))
  expect(screen.getByRole("link", { name: "Download for Windows" })).toBeTruthy()
  expect(screen.queryByRole("link", { name: /Apple Silicon/ })).toBeNull()
})
