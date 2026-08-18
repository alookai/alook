import { describe, expect, it } from "vitest"
import { serviceDefinitions } from "./e2e-ui/_setup/services"

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
})
