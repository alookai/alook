import { cleanAttributes } from "./schema"

export type FrontendIdentity = {
  frontend_surface: "web" | "blog" | "webview"
  client_platform: "browser" | "desktop" | "mobile"
  app_version?: string
}

export function resolveFrontendIdentity(entry: "web" | "blog", native: boolean, mobile: boolean, version?: string): FrontendIdentity {
  return {
    frontend_surface: entry === "web" && native ? "webview" : entry,
    client_platform: native ? mobile ? "mobile" : "desktop" : "browser",
    ...cleanAttributes({ app_version: version }),
  }
}
