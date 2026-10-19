import { webcrypto } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TouchSecurity1 } from "./touch-setup-browser"
import vector from "./__fixtures__/touch-security1.json"

const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "base64"))
const encoded = (value: Uint8Array) => Buffer.from(value).toString("base64")
beforeEach(async () => {
  const privateKey = await webcrypto.subtle.importKey("pkcs8", Buffer.from("302e020100300506032b656e04220420" + vector.clientPrivate, "hex"), { name: "X25519" }, true, ["deriveBits"])
  const publicKey = await webcrypto.subtle.importKey("raw", bytes(vector.clientPublic), { name: "X25519" }, true, [])
  const subtle = {
    generateKey: vi.fn(async () => ({ privateKey, publicKey })),
    exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle),
    importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
    deriveBits: webcrypto.subtle.deriveBits.bind(webcrypto.subtle),
    digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
  }
  vi.stubGlobal("crypto", { subtle }); vi.stubGlobal("window", { crypto: { subtle } })
  vi.stubGlobal("indexedDB", { cmp: (left: Uint8Array, right: Uint8Array) => Buffer.compare(Buffer.from(left), Buffer.from(right)) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe("pinned browser Security1 with independent OpenSSL vectors", () => {
  it("matches both proof messages and the continuing encrypted endpoint stream", async () => {
    const security = new TouchSecurity1({ pop: vector.pop })
    expect(encoded(await security.setup0Request())).toBe(vector.request0)
    await security.setup0Response(bytes(vector.response0))
    expect(encoded(security.setup1Request())).toBe(vector.request1)
    security.setup1Response(bytes(vector.response1))
    expect(encoded(security.encrypt(new TextEncoder().encode(vector.payload)))).toBe(vector.encryptedPayload)
    expect(new TextDecoder().decode(security.decrypt(bytes(vector.encryptedResponse)))).toBe(vector.response)
  })
  it("rejects the board proof for the wrong PoP", async () => {
    const security = new TouchSecurity1({ pop: "wrong-private-proof" })
    await security.setup0Request(); await security.setup0Response(bytes(vector.response0)); security.setup1Request()
    expect(() => security.setup1Response(bytes(vector.response1))).toThrow("Touch secure session failed.")
  })
  it("rejects a Security0 response without forwarding raw codec errors", async () => {
    const security = new TouchSecurity1({ pop: vector.pop })
    await security.setup0Request()
    await expect(security.setup0Response(bytes(vector.security0))).rejects.toThrow("Touch secure session failed.")
  })
})
