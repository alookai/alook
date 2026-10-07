import { expect, it } from "vitest"
import { resolveFrontendIdentity } from "./runtime"
import { cleanAttributes } from "./schema"

it.each([
  ["web", false, false, "web", "browser"],
  ["web", false, true, "web", "browser"],
  ["blog", false, true, "blog", "browser"],
  ["web", true, false, "webview", "desktop"],
  ["web", true, true, "webview", "mobile"],
  ["blog", true, true, "blog", "mobile"],
] as const)("classifies %s native=%s mobile=%s without treating a mobile browser as native", (entry, native, mobile, frontend_surface, client_platform) => {
  expect(resolveFrontendIdentity(entry, native, mobile, "0.1.44")).toEqual({ frontend_surface, client_platform, app_version: "0.1.44" })
})

it("keeps package version separate from optional full commit release and rejects arbitrary labels", () => {
  expect(cleanAttributes({ app_version: "0.1.44-beta.1+build.2", release: "a".repeat(40), client_platform: "desktop" })).toEqual({ app_version: "0.1.44-beta.1+build.2", release: "a".repeat(40), client_platform: "desktop" })
  for (const app_version of [undefined, "", "SECRET", "a".repeat(40), "01.1.44", "0.1", "0.1.44?token=SECRET", "0.1.44-" + "a".repeat(100)]) {
    expect(resolveFrontendIdentity("web", true, false, app_version)).not.toHaveProperty("app_version")
  }
  expect(cleanAttributes({ app_version: "0.1.44", release: "0.1.44", client_platform: "SECRET", native_version: "SECRET" })).toEqual({ app_version: "0.1.44" })
})
