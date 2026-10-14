import { describe, expect, it } from "vitest"
import { readBoundedJsonRequest } from "../src/http-json"

const encoder = new TextEncoder()
const url = "http://localhost/bounded-json"
function streaming(chunks: Uint8Array[], cancel?: () => void) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk) },
    cancel,
  })
  return new Request(url, { method: "POST", body, duplex: "half" } as RequestInit)
}

describe("bounded HTTP JSON", () => {
  it("decodes UTF-8 split across chunks and reports bytes rather than characters", async () => {
    const bytes = encoder.encode(JSON.stringify({ text: "你好🌍" }))
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 10))
      controller.enqueue(bytes.slice(10))
      controller.close()
    } })
    const request = new Request(url, { method: "POST", body, duplex: "half" } as RequestInit)
    expect(await readBoundedJsonRequest(request, bytes.length)).toEqual({ ok: true, value: { text: "你好🌍" }, byteCount: bytes.length })
  })

  it("rejects an oversized declared body before consuming it", async () => {
    const request = new Request(url, { method: "POST", headers: { "content-length": "1000" }, body: "{}" })
    expect(await readBoundedJsonRequest(request, 8)).toEqual({ ok: false, reason: "oversized", byteCount: 1000 })
    expect(request.bodyUsed).toBe(false)
  })

  it.each(["invalid", "-1", "1.5", "9007199254740992"])("bounds actual bytes when declared length is %s", async (length) => {
    const request = new Request(url, { method: "POST", headers: { "content-length": length }, body: "{}" })
    expect(await readBoundedJsonRequest(request, 2)).toEqual({ ok: true, value: {}, byteCount: 2 })
  })

  it.each([false, true])("cancels an oversized stream even if cancellation fails: %s", async (rejectCancellation) => {
    let cancelled = false
    const request = streaming([encoder.encode("{\"x\":"), encoder.encode("123456789}")], () => {
      cancelled = true
      if (rejectCancellation) throw new Error("cancel failed")
    })
    expect(await readBoundedJsonRequest(request, 8)).toEqual({ ok: false, reason: "oversized", byteCount: 15 })
    expect(cancelled).toBe(true)
  })

  it("contains a body stream failure", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("read failed")) } })
    const request = new Request(url, { method: "POST", body, duplex: "half" } as RequestInit)
    expect(await readBoundedJsonRequest(request, 8)).toEqual({ ok: false, reason: "invalid-json", byteCount: 0 })
  })

  it("rejects invalid UTF-8 rather than replacing it before parsing", async () => {
    const request = streaming([new Uint8Array([0xff, 0xff])])
    expect(await readBoundedJsonRequest(request, 1)).toEqual({ ok: false, reason: "oversized", byteCount: 2 })
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0xff])); controller.close() } })
    expect(await readBoundedJsonRequest(new Request(url, { method: "POST", body, duplex: "half" } as RequestInit), 8)).toEqual({ ok: false, reason: "invalid-json", byteCount: 1 })
  })

  it("rejects absent, empty and malformed JSON bodies", async () => {
    for (const body of [undefined, "", "{"]) {
      const request = new Request(url, { method: "POST", ...(body === undefined ? {} : { body }) })
      expect(await readBoundedJsonRequest(request, 8)).toEqual({ ok: false, reason: "invalid-json", byteCount: body?.length ?? 0 })
    }
  })
})
