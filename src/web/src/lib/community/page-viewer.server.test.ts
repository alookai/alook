import { describe, expect, it } from "vitest"
import { pageHostOrigin, pageServiceAuthorized, pageTicketHash } from "./page-viewer.server"

describe("Page host trust boundary", () => {
  it("allows only a configured HTTPS origin or local loopback without URL credentials or paths", () => {
    expect(pageHostOrigin("https://pages.example.invalid")).toBe("https://pages.example.invalid")
    expect(pageHostOrigin("http://localhost:8789")).toBe("http://localhost:8789")
    for (const url of [undefined, "http://remote.invalid", "https://a:b@remote.invalid", "https://remote.invalid/evil", "https://remote.invalid/?q=1", "javascript:alert(1)"]) {
      expect(pageHostOrigin(url)).toBeNull()
    }
  })

  it("checks the dedicated service credential and accepts only correctly sized opaque tickets", () => {
    const secret = "test-key-material-with-at-least-32-bytes"
    const req = (value: string) => new Request("https://alook.invalid", { headers: { authorization: value } })
    expect(pageServiceAuthorized(req(`Bearer ${secret}`), secret)).toBe(true)
    expect(pageServiceAuthorized(req(`Bearer ${secret}x`), secret)).toBe(false)
    expect(pageServiceAuthorized(req(`Bearer ${secret}`), undefined)).toBe(false)
    expect(pageServiceAuthorized(req("Bearer short"), "short")).toBe(false)
    expect(pageTicketHash("a".repeat(43))).toMatch(/^[0-9a-f]{64}$/)
    expect(pageTicketHash("a".repeat(42))).toBeNull()
    expect(pageTicketHash("?".repeat(43))).toBeNull()
  })
})
