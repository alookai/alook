import { describe, it, expect } from "vitest"
import { encrypt, decrypt } from "../../src/utils/crypto"

const SECRET = "test-secret-key-for-encryption"

describe("encrypt / decrypt", () => {
  it("round-trips a normal string", () => {
    const plain = "hello world"
    expect(decrypt(encrypt(plain, SECRET), SECRET)).toBe(plain)
  })

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt("", SECRET), SECRET)).toBe("")
  })

  it("round-trips unicode", () => {
    const plain = "こんにちは 🌍 café"
    expect(decrypt(encrypt(plain, SECRET), SECRET)).toBe(plain)
  })

  it("round-trips a long string (>1KB)", () => {
    const plain = "a".repeat(2000)
    expect(decrypt(encrypt(plain, SECRET), SECRET)).toBe(plain)
  })

  it("produces different ciphertext each time (random IV)", () => {
    const plain = "deterministic?"
    const a = encrypt(plain, SECRET)
    const b = encrypt(plain, SECRET)
    expect(a).not.toBe(b)
    expect(decrypt(a, SECRET)).toBe(plain)
    expect(decrypt(b, SECRET)).toBe(plain)
  })

  it("fails to decrypt with wrong key", () => {
    const enc = encrypt("secret", SECRET)
    expect(() => decrypt(enc, "wrong-key")).toThrow()
  })

  it("fails on tampered ciphertext (GCM auth tag)", () => {
    const enc = encrypt("secret", SECRET)
    const buf = Buffer.from(enc, "base64")
    buf[buf.length - 1] ^= 0xff
    const tampered = buf.toString("base64")
    expect(() => decrypt(tampered, SECRET)).toThrow()
  })
})
