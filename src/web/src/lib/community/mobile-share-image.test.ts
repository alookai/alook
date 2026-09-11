import { afterEach, describe, expect, it, vi } from "vitest"
import { tauriInvoke } from "@alook/shared"
import {
  MOBILE_SHARE_IMAGE_CHUNK_BYTES,
  MOBILE_SHARE_IMAGE_MAX_BYTES,
  MobileShareImageError,
  copyMobileShareImage,
  encodeMobileShareImageBytes,
  saveMobileShareImage,
} from "./mobile-share-image"

vi.mock("@alook/shared", () => ({ tauriInvoke: vi.fn() }))

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251)
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

describe("mobile share image transport", () => {
  afterEach(() => {
    vi.mocked(tauriInvoke).mockReset()
    vi.restoreAllMocks()
  })

  it.each([
    1,
    2,
    3,
    MOBILE_SHARE_IMAGE_CHUNK_BYTES - 1,
    MOBILE_SHARE_IMAGE_CHUNK_BYTES,
    MOBILE_SHARE_IMAGE_CHUNK_BYTES + 1,
    MOBILE_SHARE_IMAGE_CHUNK_BYTES * 2 - 1,
    MOBILE_SHARE_IMAGE_CHUNK_BYTES * 2,
    MOBILE_SHARE_IMAGE_CHUNK_BYTES * 2 + 1,
  ])("round trips %i bytes with final-chunk-only padding", (length) => {
    const source = bytes(length)
    const encoded = encodeMobileShareImageBytes(source)
    expect(decode(encoded)).toEqual(source)
    expect(encoded.slice(0, -4)).not.toContain("=")
  })

  it("routes copy through the mobile command with one canonical request", async () => {
    vi.mocked(tauriInvoke).mockImplementation(async (command, args) => {
      const payload = (args as { payload: { attemptId: string; pngBase64: string } }).payload
      expect(command).toBe("mobile_share_image_copy")
      expect(payload.attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(decode(payload.pngBase64)).toEqual(bytes(7))
      return {
        attemptId: payload.attemptId,
        status: "copied",
        destination: "clipboard",
      }
    })

    await expect(
      copyMobileShareImage(new Blob([bytes(7)], { type: "image/png" })),
    ).resolves.toMatchObject({ status: "copied", destination: "clipboard" })
    expect(tauriInvoke).toHaveBeenCalledOnce()
  })

  it("routes save with the exact filename and accepts the 10 MiB boundary", async () => {
    const arrayBuffer = vi.fn(async () => bytes(3).buffer)
    const blob = {
      type: "image/png",
      size: MOBILE_SHARE_IMAGE_MAX_BYTES,
      arrayBuffer,
    } as Blob
    vi.mocked(tauriInvoke).mockImplementation(async (command, args) => {
      const payload = (args as {
        payload: { attemptId: string; filename: string; pngBase64: string }
      }).payload
      expect(command).toBe("mobile_share_image_save")
      expect(payload.filename).toBe("card.png")
      expect(decode(payload.pngBase64)).toEqual(bytes(3))
      return {
        attemptId: payload.attemptId,
        status: "saved",
        destination: "photos",
      }
    })

    await expect(saveMobileShareImage(blob, "card.png")).resolves.toMatchObject({
      status: "saved",
      destination: "photos",
    })
    expect(arrayBuffer).toHaveBeenCalledOnce()
    expect(tauriInvoke).toHaveBeenCalledOnce()
  })

  it("waits for the matching native terminal result", async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(tauriInvoke).mockReturnValue(new Promise(resolvePromise => {
      resolve = resolvePromise
    }))
    vi.spyOn(crypto, "getRandomValues").mockImplementation((value) => {
      const output = value as Uint8Array
      output.fill(7)
      return value
    })
    const pending = saveMobileShareImage(new Blob([bytes(32)], { type: "image/png" }), "card.png")
    let settled = false
    void pending.finally(() => { settled = true })
    await vi.waitFor(() => expect(tauriInvoke).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    const call = vi.mocked(tauriInvoke).mock.calls[0]!
    const id = (call[1] as { payload: { attemptId: string } }).payload.attemptId
    resolve({ attemptId: id, status: "saved", destination: "pictures" })
    await expect(pending).resolves.toEqual({ attemptId: id, status: "saved", destination: "pictures" })
  })

  it.each([
    ["empty PNG", { type: "image/png", size: 0 }, "invalid_png"],
    ["wrong MIME", { type: "image/jpeg", size: 1 }, "invalid_png"],
    [
      "oversize PNG",
      { type: "image/png", size: MOBILE_SHARE_IMAGE_MAX_BYTES + 1 },
      "image_too_large",
    ],
  ])("rejects %s before reading bytes or invoking IPC", async (_label, fields, code) => {
    const arrayBuffer = vi.fn(async () => bytes(1).buffer)
    const blob = { ...fields, arrayBuffer } as Blob

    await expect(saveMobileShareImage(blob, "card.png")).rejects.toMatchObject({ code })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it.each([
    [{ attemptId: "wrong", status: "saved", destination: "pictures" }],
    [{ attemptId: null, status: "saved", destination: "pictures" }],
    [{ status: "copied", destination: "clipboard" }],
    [{ attemptId: "wrong", status: "copied", destination: "clipboard" }],
  ])("rejects a mismatched native terminal result %#", async (result) => {
    vi.mocked(tauriInvoke).mockResolvedValue(result)
    const operation = result.status === "copied"
      ? copyMobileShareImage(new Blob([bytes(4)], { type: "image/png" }))
      : saveMobileShareImage(new Blob([bytes(4)], { type: "image/png" }), "card.png")

    await expect(operation).rejects.toEqual(
      new MobileShareImageError("write_failed", "Native image result did not match the request"),
    )
    expect(tauriInvoke).toHaveBeenCalledOnce()
  })

  it("preserves a stable native rejection code and never retries", async () => {
    vi.mocked(tauriInvoke).mockRejectedValue({ code: "cancelled", message: "cancelled" })
    await expect(
      saveMobileShareImage(new Blob([bytes(4)], { type: "image/png" }), "card.png"),
    ).rejects.toEqual(new MobileShareImageError("cancelled", "cancelled"))
    expect(tauriInvoke).toHaveBeenCalledOnce()
  })

  it.each([
    "untrusted_caller",
    "invalid_png",
    "image_too_large",
    "busy",
    "permission_denied",
    "cancelled",
    "write_failed",
    "unavailable",
  ] as const)("preserves native %s failures", async (code) => {
    vi.mocked(tauriInvoke).mockRejectedValue({ code })

    await expect(
      copyMobileShareImage(new Blob([bytes(4)], { type: "image/png" })),
    ).rejects.toEqual(new MobileShareImageError(code, "Native image operation failed"))
    expect(tauriInvoke).toHaveBeenCalledOnce()
  })

  it("maps unknown bridge failures to unavailable", async () => {
    vi.mocked(tauriInvoke).mockRejectedValue(new Error("bridge exploded"))

    await expect(
      copyMobileShareImage(new Blob([bytes(4)], { type: "image/png" })),
    ).rejects.toEqual(
      new MobileShareImageError("unavailable", "Native image operation is unavailable"),
    )
  })
})
