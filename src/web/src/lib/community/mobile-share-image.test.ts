import { afterEach, describe, expect, it, vi } from "vitest"
import { tauriInvoke } from "@alook/shared"
import {
  MOBILE_SHARE_IMAGE_MAX_BYTES,
  MobileShareImageError,
  copyMobileShareImage,
  saveMobileShareImage,
} from "./mobile-share-image"

vi.mock("@alook/shared", () => ({ tauriInvoke: vi.fn() }))

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251)
}

describe("mobile share image transport", () => {
  afterEach(() => {
    vi.mocked(tauriInvoke).mockReset()
    vi.restoreAllMocks()
  })

  it("routes copy through the mobile command with raw binary IPC and attempt header", async () => {
    vi.mocked(tauriInvoke).mockImplementation(async (command, args, options) => {
      const headers = options?.headers ?? {}
      const attemptId = headers["x-attempt-id"]
      expect(command).toBe("mobile_share_image_copy")
      expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(headers["x-filename"]).toBeUndefined()
      expect(args).toBeInstanceOf(Uint8Array)
      expect(args).toEqual(bytes(7))
      return {
        attemptId,
        status: "copied",
        destination: "clipboard",
      }
    })

    await expect(
      copyMobileShareImage(new Blob([bytes(7)], { type: "image/png" })),
    ).resolves.toMatchObject({ status: "copied", destination: "clipboard" })
    expect(tauriInvoke).toHaveBeenCalledOnce()
  })

  it("routes save with percent-encoded Unicode filename and accepts the 10 MiB boundary", async () => {
    const arrayBuffer = vi.fn(async () => bytes(3).buffer)
    const blob = {
      type: "image/png",
      size: MOBILE_SHARE_IMAGE_MAX_BYTES,
      arrayBuffer,
    } as Blob
    vi.mocked(tauriInvoke).mockImplementation(async (command, args, options) => {
      const headers = options?.headers ?? {}
      expect(command).toBe("mobile_share_image_save")
      expect(headers["x-filename"]).toBe(encodeURIComponent("café card.png"))
      expect(args).toBeInstanceOf(Uint8Array)
      expect(args).toEqual(bytes(3))
      return {
        attemptId: headers["x-attempt-id"],
        status: "saved",
        destination: "photos",
      }
    })

    await expect(saveMobileShareImage(blob, "café card.png")).resolves.toMatchObject({
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
    const id = call[2]?.headers?.["x-attempt-id"]
    expect(id).toBeTypeOf("string")
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
