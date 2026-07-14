import { describe, it, expect } from "vitest"
import { machineName } from "./machine-name"

describe("machineName", () => {
  it("prefers displayName when present", () => {
    expect(machineName({ displayName: "Studio", hostname: "mac-01" })).toBe("Studio")
    expect(machineName({ displayName: "  Studio  ", hostname: "mac-01" })).toBe("Studio")
  })

  it("falls back to hostname when displayName is empty", () => {
    expect(machineName({ displayName: "", hostname: "mac-01" })).toBe("mac-01")
    expect(machineName({ displayName: "   ", hostname: "mac-01" })).toBe("mac-01")
    expect(machineName({ hostname: "mac-01" })).toBe("mac-01")
  })

  it("falls back to 'Unnamed machine' when neither is present", () => {
    expect(machineName({})).toBe("Unnamed machine")
    expect(machineName(null)).toBe("Unnamed machine")
    expect(machineName({ displayName: "", hostname: "" })).toBe("Unnamed machine")
  })
})
