import { describe, expect, it } from "vitest"
import { encodeQrCode } from "./qr-code"

function assertFinderPattern(modules: boolean[][], top: number, left: number) {
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const expected =
        dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
      expect(modules[top + dr]![left + dc]).toBe(expected)
    }
  }
}

describe("encodeQrCode", () => {
  it("encodes short payloads in Version 1 (21x21) with valid finder and timing patterns", () => {
    const qr = encodeQrCode("https://a.co")
    expect(qr.version).toBe(1)
    expect(qr.size).toBe(21)
    assertFinderPattern(qr.modules, 0, 0)
    assertFinderPattern(qr.modules, 0, 14)
    assertFinderPattern(qr.modules, 14, 0)
    // Timing strips alternate starting with dark at (6, 8) and (8, 6)
    for (let i = 8; i < 13; i++) {
      expect(qr.modules[6]![i]).toBe(i % 2 === 0)
      expect(qr.modules[i]![6]).toBe(i % 2 === 0)
    }
    // Always-dark module at (size - 8, 8)
    expect(qr.modules[13]![8]).toBe(true)
    expect(qr.pathData).toContain("M0 0h1v1h-1z")
  })

  it("encodes realistic WeChat iLink liteapp URLs cleanly", () => {
    const url = "https://liteapp.weixin.qq.com/q/7VuYN?qrcode=0123456789abcdef0123456789abcdef&bot_type=3"
    const qr = encodeQrCode(url)
    expect(qr.version).toBeGreaterThanOrEqual(4)
    expect(qr.version).toBeLessThanOrEqual(10)
    expect(qr.size).toBe(qr.version * 4 + 17)
    assertFinderPattern(qr.modules, 0, 0)
    assertFinderPattern(qr.modules, 0, qr.size - 7)
    assertFinderPattern(qr.modules, qr.size - 7, 0)
    expect(qr.modules[qr.size - 8]![8]).toBe(true)
    expect(qr.pathData.length).toBeGreaterThan(500)
  })

  it("supports Version 7+ with version information blocks and rejects oversized payloads", () => {
    const longUrl = `https://example.com/qr?token=${"a".repeat(120)}`
    const qr = encodeQrCode(longUrl)
    expect(qr.version).toBeGreaterThanOrEqual(7)
    expect(qr.size).toBe(qr.version * 4 + 17)
    expect(() => encodeQrCode("x".repeat(300))).toThrow(/capacity/)
  })
})
