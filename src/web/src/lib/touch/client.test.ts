import { describe, expect, it } from "vitest"
import { isTouchClient } from "./client"

describe("verified Touch client type", () => {
  it("uses canonical server metadata without a browser client-ID constant", () => {
    expect(isTouchClient({ client_type: "touch", client_id: "configured-fixture-id" })).toBe(true)
  })
  it.each([undefined, null, false, 1, "touch", [], {}, { client_id: "alook-touch" }, { client_type: null }, { client_type: "Touch" }, { client_type: "cli" }])("rejects absent or malformed verification metadata: %j", value => {
    expect(isTouchClient(value)).toBe(false)
  })
})
