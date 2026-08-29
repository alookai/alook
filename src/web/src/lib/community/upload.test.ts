import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    writeJSON: (data: unknown, status = 200) =>
      NextResponse.json(data, { status }),
  }
})

const mockGetDb = vi.fn(() => ({ __db: true }))
vi.mock("@/lib/db", () => ({ getDb: (...a: unknown[]) => mockGetDb(...a) }))

const mockGetChannelType = vi.fn()
const mockCreatePendingAttachment = vi.fn()
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
        createPendingAttachment: (...a: unknown[]) => mockCreatePendingAttachment(...a),
      },
    },
  }
})

// runAttachmentUpload now owns access + surface dispatch via
// requireMessageSurfaceAccess (kind is DERIVED from its returned surface +
// channel.type, no separate getChannelType re-query). Mock it to drive each arm.
const mockRequireMessageSurfaceAccess = vi.fn()
vi.mock("./permissions", () => ({
  requireMessageSurfaceAccess: (...a: unknown[]) => mockRequireMessageSurfaceAccess(...a),
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
  return { COMMUNITY_MEDIA: { put, delete: del } } as unknown as Env
}

/**
 * Build a request whose `formData()` returns a hand-rolled FormData. Going
 * through real multipart serialization would reconstruct the File on read,
 * which loses the synthetic `size` we set for oversize tests.
 */
function reqWithFile(file: unknown | null): NextRequest {
  const fd = new FormData()
  if (file) {
    // FormData.set requires a real Blob; stash the test object on the
    // FormData proxy directly instead.
    ; (fd as unknown as { __file: unknown }).__file = file
  }
  const req = new NextRequest("http://localhost/u", { method: "POST" })
  req.formData = (async () => {
    const real = new FormData()
    if (file) {
      // get() on FormData looks up by key — we override to return our file.
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
    arrayBuffer: async () => new ArrayBuffer(0),
    stream: () => new ReadableStream(),
  }
}

describe("handleAttachmentUpload", () => {
  beforeEach(() => vi.clearAllMocks())

  const USER_TAG = { uploader: "user" as const, uploaderUserId: "u1" }

  it("uploads a file under the size cap", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", USER_TAG)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.r2Key).toMatch(/^channel\/c1\/[0-9a-f-]+\/hi\.png$/)
    expect(res.contentType).toBe("image/png")
    expect(res.size).toBe(10)
    expect(put).toHaveBeenCalledOnce()
    const [, , options] = put.mock.calls[0]
    expect(options.customMetadata).toMatchObject({ uploader: "user" })
  })

  it("stores a validated JPEG thumbnail beside the original with matching provenance", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    const thumbnail = {
      ...fakeFile("thumbnail.jpg", "image/jpeg", 4),
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }
    const res = await handleAttachmentUpload(
      reqWithUpload(file, thumbnail), envWithR2(put), "channel", "c1", USER_TAG,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.thumbnailR2Key).toBe(`${res.r2Key}.thumbnail.jpg`)
    expect(res).toMatchObject({ width: 640, height: 480 })
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[0]?.[2]?.customMetadata).toMatchObject({ variant: "original" })
    expect(put.mock.calls[1]).toEqual([
      res.thumbnailR2Key,
      thumbnail,
      expect.objectContaining({
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: expect.objectContaining({ uploader: "user", variant: "thumbnail" }),
      }),
    ])
  })

  it("rejects malformed supplied thumbnails before either R2 put", async () => {
    const put = vi.fn()
    const thumbnail = {
      ...fakeFile("thumbnail.jpg", "image/jpeg", 4),
      arrayBuffer: async () => Uint8Array.from([0, 1, 2, 3]).buffer,
    }
    const res = await handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), thumbnail),
      envWithR2(put), "channel", "c1", USER_TAG,
    )
    expect(res.ok).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: "non-raster original",
      file: fakeFile("doc.pdf", "application/pdf", 10),
      thumbnail: { ...fakeFile("thumbnail.jpg", "image/jpeg", 4), arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer },
    },
    {
      label: "wrong thumbnail MIME",
      file: fakeFile("photo.png", "image/png", 10),
      thumbnail: { ...fakeFile("thumbnail.png", "image/png", 4), arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer },
    },
    {
      label: "oversized thumbnail",
      file: fakeFile("photo.png", "image/png", 10),
      thumbnail: { ...fakeFile("thumbnail.jpg", "image/jpeg", 50 * 1024 + 1), arrayBuffer: async () => new ArrayBuffer(0) },
    },
  ])("rejects $label before either R2 put", async ({ file, thumbnail }) => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(
      reqWithUpload(file, thumbnail), envWithR2(put), "channel", "c1", USER_TAG,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    { uploader: "user" as const, uploaderUserId: "u1" },
    { uploader: "bot" as const, uploaderUserId: "bot_ada" },
  ])("sanitizes $uploader original-compensation failures after a thumbnail put rejects", async (uploaderTag) => {
    const thumbnailFailure = new Error("r2 thumbnail")
    const put = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(thumbnailFailure)
    const cleanupSecret = "provider-secret channel/c1/original.png"
    const del = vi.fn().mockRejectedValueOnce(new TypeError(cleanupSecret))
    const thumbnail = {
      ...fakeFile("thumbnail.jpg", "image/jpeg", 4),
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }
    const upload = handleAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), thumbnail),
      envWithR2(put, del), "channel", "c1", uploaderTag,
    )

    await expect(upload).rejects.toBe(thumbnailFailure)
    const originalKey = put.mock.calls[0]?.[0]
    expect(originalKey).toMatch(/^channel\/c1\/[0-9a-f-]+\/hi\.png$/)
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith(originalKey)
    expect(mockLogError).toHaveBeenCalledTimes(1)
    expect(mockLogError).toHaveBeenCalledWith("attachment_thumbnail_put_cleanup_failed", {
      uploader: uploaderTag.uploader,
      route: "channels/[id]/attachments",
      phase: "thumbnail_put_original_compensation",
      objectCount: 1,
      errorCategory: "TypeError",
    })
    const serializedWarning = JSON.stringify(mockLogError.mock.calls)
    expect(serializedWarning).not.toContain(cleanupSecret)
    expect(serializedWarning).not.toContain(String(originalKey))
  })

  it("stamps customMetadata.uploader=bot + bot_user_id when the caller is a bot", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", {
      uploader: "bot",
      uploaderUserId: "bot_ada",
    })
    expect(res.ok).toBe(true)
    const [, , options] = put.mock.calls[0]
    expect(options.customMetadata).toEqual({
      uploader: "bot",
      bot_user_id: "bot_ada",
      variant: "original",
    })
  })

  it("passes a known-length File body to R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", USER_TAG)
    expect(put).toHaveBeenCalledOnce()
    const [, body] = put.mock.calls[0]
    expect(body).toBe(file)
    expect(body).toMatchObject({ size: 10, type: "image/png" })
    expect(body).not.toBeInstanceOf(ReadableStream)
    expect(body).not.toBeInstanceOf(ArrayBuffer)
  })

  it("rejects when no file part is present (400)", async () => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(reqWithFile(null), envWithR2(put), "channel", "c1", USER_TAG)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
  })

  it("rejects oversize files with 413", async () => {
    const put = vi.fn()
    const file = fakeFile("big.png", "image/png", MAX_ATTACHMENT_SIZE_BYTES + 1)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", USER_TAG)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })

  it("accepts arbitrary MIME types", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("evil.exe", "application/x-msdownload", 2)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", USER_TAG)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.contentType).toBe("application/x-msdownload")
    expect(put).toHaveBeenCalledOnce()
    expect(put.mock.calls[0]?.[2]?.httpMetadata).toEqual({ contentType: "application/x-msdownload" })
  })

  it("normalizes an empty browser MIME to application/octet-stream", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("unknown.blend", "", 2)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", USER_TAG)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.contentType).toBe("application/octet-stream")
    expect(put.mock.calls[0]?.[2]?.httpMetadata).toEqual({ contentType: "application/octet-stream" })
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
      const res = await handleAttachmentUpload(reqWithFile(f), envWithR2(put), "dm", "d1", USER_TAG)
      expect(res.ok).toBe(true)
    }
    expect(put).toHaveBeenCalledTimes(cases.length)
  })

  it("sanitizes traversal + slash characters out of the R2 key", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("../evil/../name.png", "image/png", 4)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1", USER_TAG)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // No `..`, no `/` beyond the three fixed structural separators.
    const trailing = res.r2Key.replace(/^channel\/c1\/[0-9a-f-]+\//, "")
    expect(trailing).not.toContain("..")
    expect(trailing).not.toContain("/")
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
    // Reserve-by-id: the human arm now creates a pending row at upload and
    // returns its id. Default the query to echo a stable id.
    mockCreatePendingAttachment.mockResolvedValue({ id: "att_1", filename: "hi.png" })
  })

  function ctxWith(env: Env, params: Record<string, string> | undefined) {
    return {
      env,
      userId: "u1",
      email: "u@t.com",
      params,
    }
  }

  // Drive the surface dispatch: `surface="dm"` or `surface="channel"` with a
  // channel row carrying `.type`. kind is DERIVED from these (no getChannelType).
  function surfaceChannel(type: string) {
    mockRequireMessageSurfaceAccess.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "c1", type } },
    })
  }
  function surfaceDm() {
    mockRequireMessageSurfaceAccess.mockResolvedValue({
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
    expect(mockRequireMessageSurfaceAccess).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("forwards surface-access failures with the reported status + error", async () => {
    const put = vi.fn()
    mockRequireMessageSurfaceAccess.mockResolvedValue({ ok: false, status: 403, error: "forbidden" })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("forbidden")
    expect(put).not.toHaveBeenCalled()
  })

  it("channel (text) surface → kind 'channel', channel/ R2 prefix, creates a pending row + returns its id (reserve-by-id)", async () => {
    // Happy path — access passes, streaming upload succeeds, a PENDING row is
    // created and its id returned (reserve-by-id, route/disc step 2b). A text
    // channel derives kind="channel" (== what the old channels/[id]/upload
    // passed). NO `url` in the response anymore — the display url is id-addressed
    // and derived client-side.
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
    // Single-source: the upload response carries NO url (client derives it).
    expect(body.url).toBeUndefined()
    // Pending row created with the credential uploaderId + resolved target.
    expect(mockCreatePendingAttachment).toHaveBeenCalledWith(
      { __db: true },
      expect.objectContaining({ uploaderId: "u1", targetId: "c1" }),
    )
    expect(put).toHaveBeenCalledOnce()
    // Known-length R2 body rule applies here too — the shared helper must not
    // hand R2 an unknown-length ReadableStream or buffer into ArrayBuffer.
    const [key, streamed] = put.mock.calls[0]
    expect(key).toMatch(/^channel\/c1\//)
    expect(streamed).toMatchObject({ size: 10, type: "image/png" })
    expect(streamed).not.toBeInstanceOf(ReadableStream)
    expect(streamed).not.toBeInstanceOf(ArrayBuffer)
  })

  it("threads client-supplied image dimensions onto the pending row (single source = upload)", async () => {
    surfaceChannel("text")
    const put = vi.fn().mockResolvedValue(undefined)
    // reqWithFile only stubs `get('file')`; extend it to also return w/h so the
    // form-dimension parse in readFile sees them.
    const req = reqWithFile(fakeFile("hi.png", "image/png", 10))
    req.formData = (async () => {
      const real = new FormData()
      Object.defineProperty(real, "get", {
        value: (key: string) =>
          key === "file"
            ? fakeFile("hi.png", "image/png", 10)
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
    expect(mockCreatePendingAttachment).toHaveBeenCalledWith(
      { __db: true },
      expect.objectContaining({ width: 1920, height: 1080 }),
    )
  })

  it("dm surface → kind 'dm', dm/ R2 prefix (== old dm/[id]/upload's kind, buildMediaKey parity)", async () => {
    surfaceDm()
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "d1" }),
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^dm\/d1\//)
  })

  it("channel surface + type 'thread' → kind 'thread', thread/ R2 prefix (== old threads/[id]/upload's kind)", async () => {
    surfaceChannel("thread")
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^thread\/c1\//)
  })

  it("channel surface + forum top-level → kind 'channel' (phase2 forum≡thread write-guard reversal — forum is now a message-bearing surface)", async () => {
    surfaceChannel("forum")
    const put = vi.fn().mockResolvedValue(undefined)
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^channel\/c1\//)
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

  it("deletes the original and thumbnail when the human pending-row insert fails", async () => {
    surfaceChannel("text")
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1"))
    const put = vi.fn().mockResolvedValue(undefined)
    const del = vi.fn().mockResolvedValue(undefined)
    const thumbnail = {
      ...fakeFile("thumbnail.jpg", "image/jpeg", 4),
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }
    const response = await runAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), thumbnail),
      ctxWith(envWithR2(put, del), { id: "c1" }),
    )
    expect(response.status).toBe(500)
    expect(del).toHaveBeenCalledOnce()
    const keys = del.mock.calls[0]?.[0] as string[]
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(`${keys[0]}.thumbnail.jpg`)
  })

  it("redacts object keys when human compensation cleanup also fails", async () => {
    surfaceChannel("text")
    mockCreatePendingAttachment.mockRejectedValueOnce(new Error("d1"))
    const put = vi.fn().mockResolvedValue(undefined)
    const del = vi.fn().mockRejectedValueOnce(new TypeError("secret provider detail"))
    const thumbnail = {
      ...fakeFile("thumbnail.jpg", "image/jpeg", 4),
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }

    const response = await runAttachmentUpload(
      reqWithUpload(fakeFile("hi.png", "image/png", 10), thumbnail),
      ctxWith(envWithR2(put, del), { id: "c1" }),
    )

    expect(response.status).toBe(500)
    const keys = del.mock.calls[0]?.[0] as string[]
    const cleanupLog = mockLogError.mock.calls.find(
      ([event]) => event === "attachment_upload_r2_cleanup_failed",
    )
    expect(cleanupLog?.[1]).toEqual({
      route: "channels/[id]/attachments",
      actor: "human",
      objectCount: 2,
      errorCategory: "TypeError",
    })
    for (const key of keys) expect(JSON.stringify(cleanupLog)).not.toContain(key)
    expect(JSON.stringify(cleanupLog)).not.toContain("secret provider detail")
  })
})
