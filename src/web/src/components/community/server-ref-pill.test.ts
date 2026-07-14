import { describe, it, expect } from "vitest"
import { describeServerRefPillView } from "./server-ref-pill"

describe("describeServerRefPillView", () => {
  it("resolved null → plain text, never a muted pill (avoids the load flash on ambiguous strings like /tmp, /api)", () => {
    const view = describeServerRefPillView({ ref: "/tmp", resolved: null })
    expect(view).toEqual({ kind: "plain", text: "/tmp" })
  })

  it("resolved present → pill with the server's id and name", () => {
    const view = describeServerRefPillView({
      ref: "/srv_1",
      resolved: { id: "srv_1", name: "Studio" },
    })
    expect(view).toEqual({ kind: "pill", label: "Studio", serverId: "srv_1" })
  })
})
