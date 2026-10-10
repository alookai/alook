import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockR2Get = vi.fn()
const mockR2Head = vi.fn()
vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => ({})) }))

const mockGetReadableAttachmentById = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityAttachment: {
        getReadableAttachmentById: (...a: unknown[]) => mockGetReadableAttachmentById(...a),
      },
      communityMessage: {
      },
      communityChannel: {
      },
    },
  }
})
vi.mock("@/lib/middleware/community-actor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/middleware/community-actor")>(
    "@/lib/middleware/community-actor",
  )
  return {
    ...actual,
    withCommunityActor: (handler: any) => async (req: any, ctx?: any) => {
      const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
      const authz = req?.headers?.get?.("Authorization") ?? ""
      const actor =
        ctx?.actor ??
        (authz.startsWith("Bearer crk_")
          ? { kind: "bot", userId: "bot_1", ownerUserId: "o_1", machineId: "m_1" }
          : { kind: "human", userId: "u1", email: "u@t.com", isBot: false })
      return handler(req, {
        env: {
          COMMUNITY_MEDIA: {
            get: (...a: unknown[]) => mockR2Get(...a),
            head: (...a: unknown[]) => mockR2Head(...a),
          },
        },
        actor,
        params,
      })
    },
  }
})

import { GET } from "./route"

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/community/channels/c1/attachments/att_1", {
    method: "GET",
    headers,
  })
}
const ctx = (attachmentId: string | undefined = "att_1", id = "c1") =>
  ({ params: { id, attachmentId } }) as any

const persistedRow = (over: Record<string, unknown> = {}) => ({
  id: "att_1",
  messageId: "m_1",
  targetId: "c_row", // the row's OWN target — deliberately != path id "c1"
  uploaderId: "someone",
  r2Key: "channel/c_row/uuid/a.png",
  filename: "a.png",
  contentType: "image/png",
  size: 10,
  width: null,
  height: null,
  ...over,
})

const r2Object = (over: Record<string, unknown> = {}, bytes = new Uint8Array(10)) => ({
  body: new Response(bytes).body,
  size: 10,
  httpMetadata: {},
  arrayBuffer: async () => bytes.slice().buffer,
  ...over,
})

function allowPersistedHuman(row = persistedRow()): void {
  mockGetReadableAttachmentById.mockResolvedValue(row)
}

describe("GET /api/community/channels/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("404 when attachmentId is missing", async () => {
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx(undefined))
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("404 when the id doesn't exist (bot)", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(null)
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await res.json()).toEqual({ error: "attachment not found" })
  })
  it("authorizes from the ROW's channel, not the path id — member of path-c1 but not row-channel → 404", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(null)

    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx("att_1", "c1"))
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("404 (not 403) when a pending row belongs to another actor — enumeration-safe", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(null)
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await res.json()).toEqual({ error: "attachment not found" })
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("bot: pending row owned by the requesting bot round-trips (200 + X-Alook-Filename)", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1" }))
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Length")).toBe("10")
    expect(res.headers.get("X-Alook-Filename")).toBe(encodeURIComponent("a.png"))
    expect(res.headers.get("Cache-Control")).toBeNull()
  })

  it("bot: ignores Range and preserves the full-download protocol", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow({
      messageId: null,
      uploaderId: "bot_1",
      filename: "clip.mp4",
      contentType: "video/mp4",
    }))
    mockR2Get.mockResolvedValue(r2Object({}, bytes))

    const res = await GET(req({ Authorization: "Bearer crk_abc", Range: "bytes=2-4" }), ctx())

    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png")
    expect(res.headers.get("X-Alook-Filename")).toBe(encodeURIComponent("clip.mp4"))
    expect(res.headers.get("Content-Range")).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it("bot: percent-encodes non-ASCII filenames per RFC 5987", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1", filename: "图表.png" }))
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    const encoded = res.headers.get("X-Alook-Filename")
    expect(encoded).toBeTruthy()
    expect(decodeURIComponent(encoded!)).toBe("图表.png")
  })

  it("human: persisted image on a channel the user is a member of → 200 inline + immutable cache, no X-Alook-Filename", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow())
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req(), ctx()) // no crk_ → human arm
    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Disposition")).toBe("inline")
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(res.headers.get("X-Alook-Filename")).toBeNull()
  })

  it("human: non-image → attachment; Content-Disposition carries the filename", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow({ contentType: "application/pdf", filename: "doc.pdf" }))
    mockR2Get.mockResolvedValue(r2Object({ httpMetadata: { contentType: "application/pdf" } }))
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Disposition")).toBe("attachment; filename=\"doc.pdf\"; filename*=UTF-8''doc.pdf")
  })

  it.each(["small-报告.bin", "📎😀.bin", 'a"b\\c.bin', "a\r\nb.bin", "plain.bin"])("human: legal filename header and exact bytes for %j", async filename => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    allowPersistedHuman(persistedRow({ filename, contentType: "application/octet-stream", size: bytes.length }))
    mockR2Get.mockResolvedValue(r2Object({ size: bytes.length }, bytes))
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(decodeURIComponent(res.headers.get("Content-Disposition")!.split("filename*=UTF-8''")[1])).toBe(filename)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it("human: full media GET is inline, byte-exact, and range-capable", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    allowPersistedHuman(persistedRow({
      filename: "clip.mp4",
      contentType: "video/mp4",
      size: bytes.byteLength,
    }))
    mockR2Get.mockResolvedValue(r2Object({}, bytes))

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Type")).toBe("video/mp4")
    expect(res.headers.get("Content-Disposition")).toBe("inline")
    expect(res.headers.get("Accept-Ranges")).toBe("bytes")
    expect(res.headers.get("Content-Length")).toBe("10")
    expect(res.headers.get("Content-Range")).toBeNull()
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it("human: generic-MIME media fallback emits a browser-playable Content-Type", async () => {
    allowPersistedHuman(persistedRow({
      filename: "voice.m4a",
      contentType: "application/octet-stream",
    }))
    mockR2Get.mockResolvedValue(r2Object())

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Type")).toBe("audio/mp4")
    expect(res.headers.get("Content-Disposition")).toBe("inline")
    expect(res.headers.get("Accept-Ranges")).toBe("bytes")
  })

  it.each([
    ["bytes=2-5", 2, 4, "bytes 2-5/10"],
    ["bytes=6-", 6, 4, "bytes 6-9/10"],
    ["bytes=-3", 7, 3, "bytes 7-9/10"],
    ["bytes=8-99", 8, 2, "bytes 8-9/10"],
  ])("human: %s returns an exact 206 R2 slice", async (range, offset, length, contentRange) => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    allowPersistedHuman(persistedRow({ filename: "clip.webm", contentType: "video/webm", size: 10 }))
    mockR2Get.mockImplementation(async (_key: string, options?: R2GetOptions) => {
      const requested = options?.range as { offset: number; length: number }
      return r2Object({}, bytes.slice(requested.offset, requested.offset + requested.length))
    })

    const res = await GET(req({ Range: range }), ctx())

    expect(res.status).toBe(206)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png", { range: { offset, length } })
    expect(res.headers.get("Content-Range")).toBe(contentRange)
    expect(res.headers.get("Content-Length")).toBe(String(length))
    expect(res.headers.get("Accept-Ranges")).toBe("bytes")
    expect(res.headers.get("Content-Disposition")).toBe("inline")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(offset, offset + length))
  })

  it.each([
    "bytes=",
    "bytes=-0",
    "bytes=5-4",
    "bytes=10-",
    "bytes=0-1,3-4",
    "items=0-1",
    "bytes=one-two",
  ])("human: malformed or unsatisfiable media range %s returns 416 without an object read", async (range) => {
    allowPersistedHuman(persistedRow({ filename: "clip.mp4", contentType: "video/mp4", size: 10 }))

    const res = await GET(req({ Range: range }), ctx())

    expect(res.status).toBe(416)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(res.headers.get("Content-Range")).toBe("bytes */10")
    expect(res.headers.get("Accept-Ranges")).toBe("bytes")
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("human: falls back to R2 HEAD for a legacy media row without size", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    allowPersistedHuman(persistedRow({ filename: "clip.mov", contentType: "video/quicktime", size: null }))
    mockR2Head.mockResolvedValue({ size: 10 })
    mockR2Get.mockResolvedValue(r2Object({}, bytes.slice(4, 7)))

    const res = await GET(req({ Range: "bytes=4-6" }), ctx())

    expect(mockR2Head).toHaveBeenCalledWith("channel/c_row/uuid/a.png")
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png", { range: { offset: 4, length: 3 } })
    expect(res.status).toBe(206)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Range")).toBe("bytes 4-6/10")
  })

  it("human: ranged media returns 502 when the authorized R2 object is missing", async () => {
    allowPersistedHuman(persistedRow({ filename: "clip.mp4", contentType: "video/mp4", size: 10 }))
    mockR2Get.mockResolvedValue(null)

    const res = await GET(req({ Range: "bytes=0-2" }), ctx())

    expect(res.status).toBe(502)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png", { range: { offset: 0, length: 3 } })
  })

  it("human: Range on non-media keeps the existing full attachment response", async () => {
    allowPersistedHuman(persistedRow({ filename: "doc.pdf", contentType: "application/pdf" }))
    mockR2Get.mockResolvedValue(r2Object({ httpMetadata: { contentType: "application/pdf" } }))

    const res = await GET(req({ Range: "bytes=2-4" }), ctx())

    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(res.headers.get("Content-Disposition")).toBe("attachment; filename=\"doc.pdf\"; filename*=UTF-8''doc.pdf")
    expect(res.headers.get("Accept-Ranges")).toBeNull()
    expect(res.headers.get("Content-Range")).toBeNull()
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png")
  })

  it("uses the shared actor-scoped file query on downloads", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow())
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Vary")).toBe("Authorization")
    expect(mockGetReadableAttachmentById).toHaveBeenCalledWith({}, "att_1", "bot_1")
  })

  it("502 when the row exists but R2 has no object (infra drift, not enumeration)", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1" }))
    mockR2Get.mockResolvedValue(null)
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(502)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("getReadableAttachmentById throws → 500 JSON envelope (no binary body leak)", async () => {
    mockGetReadableAttachmentById.mockRejectedValueOnce(new Error("d1_transient"))
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(500)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })

  it("bot: obj.arrayBuffer() throws mid-read → 500 JSON envelope, NOT a truncated 200", async () => {
    mockGetReadableAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1" }))
    mockR2Get.mockResolvedValue(
      r2Object({
        arrayBuffer: async () => {
          throw new Error("stream_error")
        },
      }),
    )
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(500)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })
})
