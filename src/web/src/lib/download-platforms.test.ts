import { expect, it } from "vitest"
import { currentDownloadTargets, downloadArchitecture, downloadPlatformFromOS } from "./download-platforms"

it.each([
  ["Mac OS", "macos"], ["macOS", "macos"], ["Windows", "windows"], ["Android", "android"],
  ["iOS", "ios"], ["Linux", "linux"], ["Ubuntu", "linux"], ["Chrome OS", "unknown"], [undefined, "unknown"],
])("normalizes the existing parser's OS %s", (name, platform) => {
  expect(downloadPlatformFromOS(name)).toBe(platform)
})

it.each([
  ["arm", "64", "arm64"], ["arm64", undefined, "arm64"], ["x86", "64", "x64"], ["amd64", undefined, "x64"],
  ["x86", "32", "unsupported"], ["arm", "32", "unsupported"], ["mips", undefined, "unsupported"], [undefined, undefined, "unknown"],
])("respects available architecture and bitness: %s / %s", (arch, bits, expected) => {
  expect(downloadArchitecture(arch, bits)).toBe(expected)
})

it("offers both real Mac packages when the browser does not reveal its chip", () => {
  expect(currentDownloadTargets({ platform: "macos", architecture: "unknown" })).toEqual(["mac-arm", "mac-intel"])
  expect(currentDownloadTargets({ platform: "macos", architecture: "arm64" })).toEqual(["mac-arm"])
  expect(currentDownloadTargets({ platform: "macos", architecture: "x64" })).toEqual(["mac-intel"])
})

it.each(["windows", "linux"] as const)("does not silently offer an x64 installer to known ARM %s", platform => {
  expect(currentDownloadTargets({ platform, architecture: "arm64" })).toEqual([])
  expect(currentDownloadTargets({ platform, architecture: "unsupported" })).toEqual([])
})
