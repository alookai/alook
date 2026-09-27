import { beforeEach, expect, it, vi } from "vitest"

const installReactScanMock = vi.fn()

vi.mock("@/lib/perf/react-scan-install", () => ({
  installReactScan: installReactScanMock,
}))

beforeEach(() => {
  vi.resetModules()
  installReactScanMock.mockReset()
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
