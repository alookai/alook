import { describe, expect, it, vi } from "vitest"
import { MAX_ATTACHMENT_SIZE_BYTES } from "@alook/shared"
import { readUploadFormData, UploadTooLargeError } from "./upload-body"

describe("bounded multipart upload", () => {
  it("accepts the advertised maximum file with multipart overhead", async () => {
    const form = new FormData()
    form.set("file", new File([new Uint8Array(MAX_ATTACHMENT_SIZE_BYTES)], "max.bin"))
    const parsed = await readUploadFormData(new Request("http://upload", { method: "POST", body: form }))
    expect((parsed.get("file") as File).size).toBe(MAX_ATTACHMENT_SIZE_BYTES)
  })
  it("rejects a declared oversized body without reading it", async () => {
    const request = new Request("http://upload", { method: "POST", headers: { "Content-Length": "999999999" } })
    await expect(readUploadFormData(request)).rejects.toBeInstanceOf(UploadTooLargeError)
  })
  it.each([undefined, "1"])("bounds streamed reads despite Content-Length %s", async (declared) => {
    const cancel = vi.fn()
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel,
    })
    const request = new Request("http://upload", {
      method: "POST", body, duplex: "half",
      headers: { "Content-Type": "multipart/form-data; boundary=test", ...(declared ? { "Content-Length": declared } : {}) },
    } as RequestInit)
    await expect(readUploadFormData(request)).rejects.toBeInstanceOf(UploadTooLargeError)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chunks).toBeLessThan(30)
    expect(cancel).toHaveBeenCalled()
  })
})

it("preserves malformed multipart errors instead of reporting overflow", async () => {
  await expect(readUploadFormData(new Request("http://upload", { method: "POST", body: "not multipart" }))).rejects.not.toBeInstanceOf(UploadTooLargeError)
})
