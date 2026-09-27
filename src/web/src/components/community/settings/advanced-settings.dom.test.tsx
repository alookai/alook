import { render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { AdvancedSettings } from "./user-settings"

const cache = vi.hoisted(() => ({
  clearAll: vi.fn(),
  size: vi.fn(),
}))

vi.mock("@/lib/query-persister", () => ({
  clearAllPersistedCaches: cache.clearAll,
  getPersistedCacheSizeBytes: cache.size,
  formatBytes: (bytes: number) => bytes === 1536 ? "1.5 KB" : `${bytes} B`,
}))

vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => Promise<void> }) => (
    open ? <button onClick={() => { void onConfirm() }}>Confirm clear cache</button> : null
  ),
}))

describe("AdvancedSettings cache size", () => {
  beforeEach(() => {
    cache.clearAll.mockReset()
    cache.size.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shows loading before the all-account cache total resolves", async () => {
    let resolveSize!: (bytes: number) => void
    cache.size.mockReturnValue(new Promise<number>((resolve) => { resolveSize = resolve }))

    render(<AdvancedSettings />)

    expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("Calculating…")
    resolveSize(1536)
    await waitFor(() => {
      expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("1.5 KB")
    })
  })

  it("shows an empty cache as 0 B", async () => {
    cache.size.mockResolvedValue(0)

    render(<AdvancedSettings />)

    await waitFor(() => {
      expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("0 B")
    })
  })

  it("shows unavailable when IndexedDB cannot be read", async () => {
    cache.size.mockRejectedValue(new Error("IndexedDB unavailable"))

    render(<AdvancedSettings />)

    await waitFor(() => {
      expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("Unavailable")
    })
  })

  it("shows 0 B after clearing and before the reload frame", async () => {
    const user = setupUser()
    cache.size.mockResolvedValue(2048)
    cache.clearAll.mockResolvedValue(undefined)
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1))
    render(<AdvancedSettings />)
    await waitFor(() => {
      expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("2048 B")
    })

    await user.click(screen.getByRole("button", { name: "Clear local cache" }))
    await user.click(screen.getByRole("button", { name: "Confirm clear cache" }))

    await waitFor(() => {
      expect(cache.clearAll).toHaveBeenCalledOnce()
      expect(screen.getByTestId(tid.settingsCacheSize)).toHaveTextContent("0 B")
    })
  })
})
