import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { structuredJpegFixture } from "@/test/fixtures/media"

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    writeJSON: (data: unknown, status = 200) =>
      NextResponse.json(data, { status }),
  }
})

const primaryDb = { __db: "primary" }
const mockGetPrimaryDb = vi.fn(() => primaryDb)
vi.mock("@/lib/db", () => ({
  getPrimaryDb: (...a: unknown[]) => mockGetPrimaryDb(...a),
}))

const mockGetChannelType = vi.fn()
const mockCreateAttachment = vi.fn()
const mockLogError = vi.fn()
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({ error: (...args: unknown[]) => mockLogError(...args) }),
    queries: {
      ...actual.queries,
      communityChannel: {
        ...actual.queries.communityChannel,
        getChannelType: (...a: unknown[]) => mockGetChannelType(...a),
      },
      communityAttachment: {
        ...actual.queries.communityAttachment,
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
      },
    },
  }
})

const mockRequireMessageSurfaceCommunicationAccess = vi.fn()
vi.mock("./permissions", () => ({
  requireMessageSurfaceCommunicationAccess: (...a: unknown[]) =>
    mockRequireMessageSurfaceCommunicationAccess(...a),
}))

import {
  handleAttachmentUpload,
  handleServerIconUpload,
  handleUserAvatarUpload,
  handleBotAvatarUpload,
  runAttachmentUpload,
} from "./upload"
import { MAX_ATTACHMENT_SIZE_BYTES, MAX_SERVER_ICON_SIZE_BYTES } from "@alook/shared"

function envWithR2(put: ReturnType<typeof vi.fn>, del = vi.fn().mockResolvedValue(undefined)) {
  return { COMMUNITY_MEDIA: {
    put: async (key: string, body: File, options: { sha256?: string }) => {
      const result = await put(key, body, options)
      return result === undefined ? { size: body.size, checksums: { sha256: options?.sha256 ? Uint8Array.from(Buffer.from(options.sha256, "hex")).buffer : undefined } } : result
    },
    delete: del,
  } } as unknown as Env
}

/**
 * Build a request whose `formData()` returns a hand-rolled FormData. Going
 * through real multipart serialization would reconstruct the File on read,
 * which loses the synthetic `size` we set for oversize tests.
 */
function reqWithFile(file: unknown | null): NextRequest {
  const fd = new FormData()
  if (file) {
            ; (fd as unknown as { __file: unknown }).__file = file
  }
  const req = new NextRequest("http://localhost/u", { method: "POST" })
  req.formData = (async () => {
    const real = new FormData()
    if (file) {
            Object.defineProperty(real, "get", {
        value: (key: string) => (key === "file" ? file : null),
      })
    } else {
      Object.defineProperty(real, "get", { value: () => null })
    }
    return real
  }) as typeof req.formData
  return req
}

function reqWithUpload(file: unknown, thumbnail: unknown, width = "640", height = "480"): NextRequest {
  const req = new NextRequest("http://localhost/u", { method: "POST" })
  req.formData = (async () => {
    const values: Record<string, unknown> = { file, thumbnail, width, height }
    return { get: (key: string) => values[key] ?? null } as unknown as FormData
  }) as typeof req.formData
  return req
}

/**
 * A File-shaped object with an overridable `size`. Real `File.size` is
 * derived from the underlying byte length and ignores `Object.defineProperty`,
 * so we hand-build the object instead of allocating real bytes.
 *
 * The upload helper passes the File-shaped object itself to R2 so the Workers
 * runtime sees a known-length body. The mocked `put` never reads it.
 */
function fakeFile(name: string, type: string, size: number) {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => new ArrayBuffer(size),
    stream() {
      const read = this.arrayBuffer()
      return new ReadableStream({ async start(controller) { controller.enqueue(new Uint8Array(await read)); controller.close() } })
    },
  }
}

function fakeJpegFile(width = 640, height = 360) {
  const bytes = structuredJpegFixture(width, height)
  return {
    ...fakeFile("thumbnail.jpg", "image/jpeg", bytes.byteLength),
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  }
}

function sofOnlyJpegFile(width = 640, height = 480) {
  const bytes = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ])
  return {
    ...fakeFile("thumbnail.jpg", "image/jpeg", bytes.byteLength),
    arrayBuffer: async () => bytes.buffer,
  }
}

function structuredJpegFile(bytes: number[]) {
  const data = Uint8Array.from(bytes)
  return {
    ...fakeFile("thumbnail.jpg", "image/jpeg", data.byteLength),
    arrayBuffer: async () => data.buffer,
  }
}

function restartMarkerJpegFile() {
  return structuredJpegFile([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x01, 0xff, 0xd0, 0x02,
    0xff, 0xd9,
  ])
}

describe("handleAttachmentUpload", () => {
  beforeEach(() => vi.clearAllMocks())


  it("uploads a file under the size cap", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.r2Key).toMatch(/^attachments\/sha256\/[0-9a-f]{64}$/)
    expect(res.contentType).toBe("image/png")
    expect(res.size).toBe(10)
    expect(put).toHaveBeenCalledOnce()
    const [, , options] = put.mock.calls[0]
    expect(options).toMatchObject({ onlyIf: { etagDoesNotMatch: "*" }, sha256: expect.any(String) })
  })

  it("accepts an original-only image at the exact policy boundaries", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("edge.png", "image/png", 256 * 1024), null, "720", "540"),
      envWithR2(put),
    )

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.thumbnailR2Key).toBeNull()
    expect(put).toHaveBeenCalledOnce()
  })

  it.each([
    ["byte size", fakeFile("large.png", "image/png", 256 * 1024 + 1), "640", "480"],
    ["width", fakeFile("wide.png", "image/png", 10), "721", "480"],
    ["height", fakeFile("tall.png", "image/png", 10), "480", "721"],
  ])("rejects a missing required thumbnail proved by %s before either R2 put", async (_label, file, width, height) => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(
      reqWithUpload(file, null, width, height), envWithR2(put),
    )

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(await res.response.json()).toMatchObject({ error: "thumbnail required" })
    expect(put).not.toHaveBeenCalled()
  })

  it("stores a validated JPEG thumbnail with its own content key", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    const thumbnail = fakeJpegFile()
    const res = await handleAttachmentUpload(
      reqWithUpload(file, thumbnail), envWithR2(put),
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.thumbnailR2Key).toMatch(/^attachment-thumbnails\/sha256\/[0-9a-f]{64}$/)
    expect(res).toMatchObject({ width: 640, height: 480 })
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[1]).toEqual([res.thumbnailR2Key, thumbnail, expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } })])
  })

  it("rejects malformed supplied thumbnails before either R2 put", async () => {
    const put = vi.fn()
    const thumbnail = {
      ...fakeFile("thumbnail.jpg", "image/jpeg", 4),
      arrayBuffer: async () => Uint8Array.from([0, 1, 2, 3]).buffer,
    }
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), thumbnail),
      envWithR2(put),
    )
    expect(res.ok).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })

  it("rejects a SOF-only JPEG-shaped thumbnail before either R2 put", async () => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), sofOnlyJpegFile()),
      envWithR2(put),
    )

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(await res.response.json()).toMatchObject({ error: "invalid jpeg thumbnail" })
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "a mismatched SOF component length",
      thumbnail: structuredJpegFile([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x0c, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0x00,
        0xff, 0xd9,
      ]),
    },
    {
      label: "a mismatched SOS component length",
      thumbnail: structuredJpegFile([
        0xff, 0xd8,
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xda, 0x00, 0x09, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00,
        0x01, 0xff, 0xd9,
      ]),
    },
    {
      label: "a segment stream without EOI",
      thumbnail: structuredJpegFile([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]),
    },
  ])("rejects $label before either R2 put", async ({ thumbnail }) => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), thumbnail),
      envWithR2(put),
    )

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(await res.response.json()).toMatchObject({ error: "invalid jpeg thumbnail" })
    expect(put).not.toHaveBeenCalled()
  })

  it("accepts entropy data containing a JPEG restart marker", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), restartMarkerJpegFile()),
      envWithR2(put),
    )

    expect(res.ok).toBe(true)
    expect(put).toHaveBeenCalledTimes(2)
  })

  it("rejects a JPEG thumbnail over 720px before either R2 put", async () => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), fakeJpegFile(721, 512)),
      envWithR2(put),
    )

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(await res.response.json()).toMatchObject({ error: "thumbnail dimensions too large" })
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "non-raster original",
      file: fakeFile("doc.pdf", "application/pdf", 10),
      thumbnail: fakeJpegFile(),
    },
    {
      label: "wrong thumbnail MIME",
      file: fakeFile("photo.png", "image/png", 10),
      thumbnail: { ...fakeJpegFile(), type: "image/png", name: "thumbnail.png" },
    },
    {
      label: "oversized thumbnail",
      file: fakeFile("photo.png", "image/png", 10),
      thumbnail: { ...fakeFile("thumbnail.jpg", "image/jpeg", 256 * 1024 + 1), arrayBuffer: async () => new ArrayBuffer(0) },
    },
  ])("rejects $label before either R2 put", async ({ file, thumbnail }) => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(
      reqWithUpload(file, thumbnail), envWithR2(put),
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
  })

  it("does not delete shared original content when thumbnail creation fails", async () => {
    const failure = new Error("r2 thumbnail")
    const put = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure)
    const del = vi.fn()
    await expect(handleAttachmentUpload(reqWithUpload(fakeFile("hi.png", "image/png", 10), fakeJpegFile()), envWithR2(put, del))).rejects.toBe(failure)
    expect(del).not.toHaveBeenCalled()
  })

  it("passes a known-length File body to R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    await handleAttachmentUpload(reqWithFile(file), envWithR2(put))
    expect(put).toHaveBeenCalledOnce()
    const [, body] = put.mock.calls[0]
    expect(body).toBe(file)
    expect(body).toMatchObject({ size: 10, type: "image/png" })
    expect(body).not.toBeInstanceOf(ReadableStream)
    expect(body).not.toBeInstanceOf(ArrayBuffer)
  })

  it("rejects when no file part is present (400)", async () => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(reqWithFile(null), envWithR2(put))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
  })

  it("rejects oversize files with 413", async () => {
    const put = vi.fn()
    const file = fakeFile("big.png", "image/png", MAX_ATTACHMENT_SIZE_BYTES + 1)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })

  it("accepts arbitrary MIME types", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("evil.exe", "application/x-msdownload", 2)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.contentType).toBe("application/x-msdownload")
    expect(put).toHaveBeenCalledOnce()
  })

  it("normalizes an empty browser MIME to application/octet-stream", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("unknown.blend", "", 2)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.contentType).toBe("application/octet-stream")
  })

  it("accepts video, audio, pdf and text MIME types", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const cases: { type: string; name: string }[] = [
      { type: "video/mp4", name: "v.mp4" },
      { type: "audio/mpeg", name: "a.mp3" },
      { type: "application/pdf", name: "doc.pdf" },
      { type: "text/plain", name: "n.txt" },
    ]
    for (const { type, name } of cases) {
      const f = fakeFile(name, type, 1)
      const res = await handleAttachmentUpload(reqWithFile(f), envWithR2(put))
      expect(res.ok).toBe(true)
    }
    expect(put).toHaveBeenCalledTimes(cases.length)
  })

  it("sanitizes traversal + slash characters out of the R2 key", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("../evil/../name.png", "image/png", 4)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.r2Key).toMatch(/^attachments\/sha256\/[0-9a-f]{64}$/)
    expect(res.filename).toBe(file.name)
  })
})

describe("handleServerIconUpload", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uploads a valid png icon", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("icon.png", "image/png", 10)
    const res = await handleServerIconUpload(reqWithFile(file), envWithR2(put), "s1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.key).toMatch(/^server-icon\/s1\/[0-9a-f-]+$/)
  })

  it("passes a known-length File icon body to R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("icon.png", "image/png", 10)
    await handleServerIconUpload(reqWithFile(file), envWithR2(put), "s1")
    expect(put).toHaveBeenCalledOnce()
    const [, body] = put.mock.calls[0]
    expect(body).toBe(file)
    expect(body).toMatchObject({ size: 10, type: "image/png" })
    expect(body).not.toBeInstanceOf(ReadableStream)
    expect(body).not.toBeInstanceOf(ArrayBuffer)
  })

  it("rejects oversize icons with 413", async () => {
    const put = vi.fn()
    const file = fakeFile("icon.png", "image/png", MAX_SERVER_ICON_SIZE_BYTES + 1)
    const res = await handleServerIconUpload(reqWithFile(file), envWithR2(put), "s1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(413)
  })

  it("rejects non-image MIME types", async () => {
    const put = vi.fn()
    const file = fakeFile("icon.bmp", "image/bmp", 10)
    const res = await handleServerIconUpload(reqWithFile(file), envWithR2(put), "s1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
  })

  it("rejects when no file is provided", async () => {
    const put = vi.fn()
    const res = await handleServerIconUpload(reqWithFile(null), envWithR2(put), "s1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
  })
})

describe("handleUserAvatarUpload", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uploads a valid png avatar under an immutable user-avatar child key", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("me.png", "image/png", 10)
    const res = await handleUserAvatarUpload(reqWithFile(file), envWithR2(put), "u1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.key).toMatch(/^user-avatar\/u1\/objects\/[0-9a-f-]+$/)
  })

  it("returns the routable avatar route URL, not the (404-ing) media catch-all shape", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("me.png", "image/png", 10)
    const res = await handleUserAvatarUpload(reqWithFile(file), envWithR2(put), "u1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.url).toBe("/api/community/users/u1/avatar")
  })

  it("re-uploading the same user allocates a distinct immutable child", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const first = await handleUserAvatarUpload(
      reqWithFile(fakeFile("a.png", "image/png", 10)),
      envWithR2(put),
      "u1",
    )
    const second = await handleUserAvatarUpload(
      reqWithFile(fakeFile("b.png", "image/png", 10)),
      envWithR2(put),
      "u1",
    )
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.key).not.toBe(second.key)
    expect(first.key).toMatch(/^user-avatar\/u1\/objects\/[0-9a-f-]+$/)
    expect(second.key).toMatch(/^user-avatar\/u1\/objects\/[0-9a-f-]+$/)
  })

  it("rejects oversize avatars with 413", async () => {
    const put = vi.fn()
    const file = fakeFile("big.png", "image/png", MAX_SERVER_ICON_SIZE_BYTES + 1)
    const res = await handleUserAvatarUpload(reqWithFile(file), envWithR2(put), "u1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })

  it("rejects non-image MIME types with 400", async () => {
    const put = vi.fn()
    const file = fakeFile("me.bmp", "image/bmp", 10)
    const res = await handleUserAvatarUpload(reqWithFile(file), envWithR2(put), "u1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
  })

  it("rejects when no file is provided", async () => {
    const put = vi.fn()
    const res = await handleUserAvatarUpload(reqWithFile(null), envWithR2(put), "u1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
  })
})

describe("handleBotAvatarUpload", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uploads a valid png avatar under an immutable bot-avatar child key", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("bot.png", "image/png", 10)
    const res = await handleBotAvatarUpload(reqWithFile(file), envWithR2(put), "b1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.key).toMatch(/^bot-avatar\/b1\/objects\/[0-9a-f-]+$/)
  })

  it("returns the routable avatar route URL, not the (404-ing) media catch-all shape", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("bot.png", "image/png", 10)
    const res = await handleBotAvatarUpload(reqWithFile(file), envWithR2(put), "b1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.url).toBe("/api/community/bots/b1/avatar")
  })

  it("rejects oversize avatars with 413", async () => {
    const put = vi.fn()
    const file = fakeFile("big.png", "image/png", MAX_SERVER_ICON_SIZE_BYTES + 1)
    const res = await handleBotAvatarUpload(reqWithFile(file), envWithR2(put), "b1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(413)
  })

  it("rejects non-image MIME types with 400", async () => {
    const put = vi.fn()
    const file = fakeFile("bot.bmp", "image/bmp", 10)
    const res = await handleBotAvatarUpload(reqWithFile(file), envWithR2(put), "b1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
  })
})

describe("runAttachmentUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks()
            mockCreateAttachment.mockResolvedValue({ id: "att_1", filename: "hi.png" })
  })

  function ctxWith(env: Env, params: Record<string, string> | undefined) {
    return {
      env,
      userId: "u1",
      email: "u@t.com",
      params,
    }
  }

      function surfaceChannel(type: string) {
    mockRequireMessageSurfaceCommunicationAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", type } },
    })
  }
  function surfaceDm() {
    mockRequireMessageSurfaceCommunicationAccess.mockResolvedValue({
      ok: true,
      value: { surface: "dm", dm: { id: "d1" } },
    })
  }

  it("returns 400 when the route id param is missing", async () => {
    const put = vi.fn()
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), undefined),
    )
    expect(res.status).toBe(400)
    expect(mockRequireMessageSurfaceCommunicationAccess).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("forwards surface-access failures with the reported status + error", async () => {
    const put = vi.fn()
    mockRequireMessageSurfaceCommunicationAccess.mockResolvedValue({ ok: false, status: 403, error: "forbidden" })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("forbidden")
    expect(mockGetPrimaryDb).toHaveBeenCalledOnce()
    expect(mockRequireMessageSurfaceCommunicationAccess).toHaveBeenCalledWith(
      primaryDb,
      "c1",
      "u1",
    )
    expect(put).not.toHaveBeenCalled()
  })

  it("authorized text upload creates a file record and returns its ID", async () => {
                        surfaceChannel("text")
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      url?: string
      filename: string
      contentType: string
      size: number
    }
    expect(body.id).toBe("att_1")
    expect(body.filename).toBe("hi.png")
    expect(body.contentType).toBe("image/png")
    expect(body.size).toBe(10)
        expect(body.url).toBeUndefined()
        expect(mockCreateAttachment).toHaveBeenCalledWith(
      primaryDb,
      expect.objectContaining({ uploaderId: "u1" }),
    )
    expect(put).toHaveBeenCalledOnce()
            const [key, streamed] = put.mock.calls[0]
    expect(key).toMatch(/^attachments\/sha256\/[0-9a-f]{64}$/)
    expect(streamed).toMatchObject({ size: 10, type: "image/png" })
    expect(streamed).not.toBeInstanceOf(ReadableStream)
    expect(streamed).not.toBeInstanceOf(ArrayBuffer)
  })

  it("threads client-supplied image dimensions onto the file record (single source = upload)", async () => {
    surfaceChannel("text")
    const put = vi.fn().mockResolvedValue(undefined)
    const thumbnail = fakeJpegFile()
            const req = reqWithFile(fakeFile("hi.png", "image/png", 10))
    req.formData = (async () => {
      const real = new FormData()
      Object.defineProperty(real, "get", {
        value: (key: string) =>
          key === "file"
            ? fakeFile("hi.png", "image/png", 10)
            : key === "thumbnail"
              ? thumbnail
            : key === "width"
              ? "1920"
              : key === "height"
                ? "1080"
                : null,
      })
      return real
    }) as typeof req.formData
    const res = await runAttachmentUpload(req, ctxWith(envWithR2(put), { id: "c1" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { width?: number; height?: number }
    expect(body.width).toBe(1920)
    expect(body.height).toBe(1080)
    expect(mockCreateAttachment).toHaveBeenCalledWith(
      primaryDb,
      expect.objectContaining({ width: 1920, height: 1080 }),
    )
  })

  it("authorized DM upload uses content keys", async () => {
    surfaceDm()
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "d1" }),
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^attachments\/sha256\/[0-9a-f]{64}$/)
  })

  it("authorized thread upload uses content keys", async () => {
    surfaceChannel("thread")
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^attachments\/sha256\/[0-9a-f]{64}$/)
  })

  it("authorized forum upload uses content keys", async () => {
    surfaceChannel("forum")
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^attachments\/sha256\/[0-9a-f]{64}$/)
  })

  it("forwards handleAttachmentUpload errors (e.g. oversize) unchanged", async () => {
    surfaceChannel("text")
    const put = vi.fn()
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("big.png", "image/png", MAX_ATTACHMENT_SIZE_BYTES + 1)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })

  it.each(["missing", "wrong-size", "missing-checksum", "wrong-checksum"])(
    "rejects an unverifiable existing R2 object (%s) without creating a file or deleting shared content",
    async (failure) => {
      surfaceChannel("text")
      const file = new File(["shared bytes"], "reuse.txt", { type: "text/plain" })
      const head = vi.fn().mockResolvedValue(failure === "missing" ? null : {
        size: failure === "wrong-size" ? file.size + 1 : file.size,
        checksums: { sha256: failure === "missing-checksum" ? undefined : new Uint8Array(32).buffer },
      })
      const put = vi.fn().mockResolvedValue(null)
      const del = vi.fn()
      const env = { COMMUNITY_MEDIA: { put, head, delete: del } } as unknown as Env
      const response = await runAttachmentUpload(reqWithFile(file), ctxWith(env, { id: "c1" }))
      expect(response.status).toBe(500)
      expect(head).toHaveBeenCalledWith(put.mock.calls[0][0])
      expect(mockCreateAttachment).not.toHaveBeenCalled()
      expect(del).not.toHaveBeenCalled()
    },
  )

  it("preserves shared content when the human file insert fails", async () => {
    surfaceChannel("text")
    mockCreateAttachment.mockRejectedValueOnce(new Error("d1"))
    const del = vi.fn()
    const response = await runAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), fakeJpegFile()),
      ctxWith(envWithR2(vi.fn().mockResolvedValue(undefined), del), { id: "c1" }),
    )
    expect(response.status).toBe(500)
    expect(del).not.toHaveBeenCalled()
  })
})
