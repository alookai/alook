import { describe, expect, it } from "vitest"
import { serviceDefinitions } from "./e2e-ui/_setup/services"
import { resolveWsUrl } from "./e2e-ui/_setup/paths"

describe("UI E2E service definitions", () => {
  it("uses one Wrangler runtime for web and ws-do in CI", () => {
    const definitions = serviceDefinitions(true)

    expect(definitions).toHaveLength(1)
    expect(definitions[0]).toMatchObject({ name: "web-ws-do" })
    expect(definitions[0]?.args).toEqual(expect.arrayContaining([
      "src/web/wrangler.toml",
      "src/ws-do/wrangler.toml",
      "--persist-to",
      "src/web/.wrangler/state",
    ]))
  })

  it("keeps the fast two-process topology for local iteration", () => {
    expect(serviceDefinitions(false).map((definition) => definition.name)).toEqual(["web", "ws-do"])
  })

  it("uses the web URL for ws-do in the CI single-runtime topology", () => {
    expect(resolveWsUrl({
      webUrl: "http://localhost:3000",
      singleRuntime: true,
    })).toBe("http://localhost:3000")
  })

  it("keeps the local ws-do port for the split-runtime topology", () => {
    expect(resolveWsUrl({
      webUrl: "http://localhost:3000",
      singleRuntime: false,
    })).toBe("http://localhost:8789")
  })

  it("always honors an explicit ws-do URL", () => {
    expect(resolveWsUrl({
      webUrl: "http://localhost:3000",
      explicitWsUrl: "http://localhost:9000",
      singleRuntime: true,
    })).toBe("http://localhost:9000")
  })
})
