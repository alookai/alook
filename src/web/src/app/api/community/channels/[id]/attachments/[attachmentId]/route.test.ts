import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockR2Get = vi.fn()
const mockR2Head = vi.fn()
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockGetAttachmentById = vi.fn()
const mockGetMessage = vi.fn()
const mockGetChannelType = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityAttachment: {
        getAttachmentById: (...a: unknown[]) => mockGetAttachmentById(...a),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        getChannelType: (...a: unknown[]) => mockGetChannelType(...a),
      },
    },
  }
})

const mockRequireChannelMember = vi.fn()
const mockRequireDMAccess = vi.fn()
vi.mock("@/lib/community/permissions", () => ({
  requireChannelMember: (...a: unknown[]) => mockRequireChannelMember(...a),
  requireDMAccess: (...a: unknown[]) => mockRequireDMAccess(...a),
}))

// Dual-actor: crk_ bearer → bot arm, else human. The route dispatches by
// actor.kind for the RESPONSE shape; the authz core is identical. A test may
// inject a specific actor via ctx.actor.
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

// params.id = the PATH channel id (routing anchor only, NEVER trusted for
// authz). params.attachmentId = the authoritative id.
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
  mockGetAttachmentById.mockResolvedValue(row)
  mockGetMessage.mockResolvedValue({ id: "m_1", channelId: "c_real" })
  mockGetChannelType.mockResolvedValue("text")
  mockRequireChannelMember.mockResolvedValue({ ok: true, value: {} })
}

describe("GET /api/community/channels/[id]/attachments/[attachmentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireChannelMember.mockResolvedValue({ ok: true, value: {} })
    mockRequireDMAccess.mockResolvedValue({ ok: true, value: {} })
  })

  it("404 when attachmentId is missing", async () => {
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx(undefined))
    expect(res.status).toBe(404)
  })

  it("404 when the id doesn't exist (bot)", async () => {
    mockGetAttachmentById.mockResolvedValue(null)
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "attachment not found" })
  })

  // ⚠ CONFUSED-DEPUTY — the top red line. The gate resolves the row's OWN
  // channel (row.targetId → row.messageId → message.channelId), NOT the path
  // `[id]`. A caller who IS a member of the path channel "c1" but NOT of the
  // row's real channel must still 404. We prove it by making the membership
  // gate observe the ROW's channel id, and by returning not-a-member there.
  it("authorizes from the ROW's channel, not the path id — member of path-c1 but not row-channel → 404", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow())
    mockGetMessage.mockResolvedValue({ id: "m_1", channelId: "c_real" })
    mockGetChannelType.mockResolvedValue("text")
    mockRequireChannelMember.mockResolvedValue({ ok: false, status: 403, error: "not a member" })

    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx("att_1", "c1"))
    expect(res.status).toBe(404)
    // The membership gate was called with the ROW's message channel, not "c1".
    expect(mockRequireChannelMember).toHaveBeenCalledWith({}, "c_real", "bot_1")
    // No path-id was consulted for authz.
    expect(mockRequireChannelMember).not.toHaveBeenCalledWith({}, "c1", expect.anything())
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("404 (not 403) when a pending row belongs to another actor — enumeration-safe", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "other" }))
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "attachment not found" })
    expect(mockR2Get).not.toHaveBeenCalled()
  })

  it("bot: pending row owned by the requesting bot round-trips (200 + X-Alook-Filename)", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1" }))
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Length")).toBe("10")
    expect(res.headers.get("X-Alook-Filename")).toBe(encodeURIComponent("a.png"))
    expect(res.headers.get("Cache-Control")).toBeNull()
  })

  it("bot: ignores Range and preserves the full-download protocol", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index)
    mockGetAttachmentById.mockResolvedValue(persistedRow({
      messageId: null,
      uploaderId: "bot_1",
      filename: "clip.mp4",
      contentType: "video/mp4",
    }))
    mockR2Get.mockResolvedValue(r2Object({}, bytes))

    const res = await GET(req({ Authorization: "Bearer crk_abc", Range: "bytes=2-4" }), ctx())

    expect(res.status).toBe(200)
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png")
    expect(res.headers.get("X-Alook-Filename")).toBe(encodeURIComponent("clip.mp4"))
    expect(res.headers.get("Content-Range")).toBeNull()
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it("bot: percent-encodes non-ASCII filenames per RFC 5987", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1", filename: "图表.png" }))
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    const encoded = res.headers.get("X-Alook-Filename")
    expect(encoded).toBeTruthy()
    expect(decodeURIComponent(encoded!)).toBe("图表.png")
  })

  it("human: persisted image on a channel the user is a member of → 200 inline + immutable cache, no X-Alook-Filename", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow())
    mockGetMessage.mockResolvedValue({ id: "m_1", channelId: "c_real" })
    mockGetChannelType.mockResolvedValue("text")
    mockRequireChannelMember.mockResolvedValue({ ok: true, value: {} })
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req(), ctx()) // no crk_ → human arm
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Disposition")).toBe("inline")
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    // Human arm never emits the bot download header.
    expect(res.headers.get("X-Alook-Filename")).toBeNull()
  })

  it("human: non-image → attachment; Content-Disposition carries the filename", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow({ contentType: "application/pdf", filename: "doc.pdf" }))
    mockGetMessage.mockResolvedValue({ id: "m_1", channelId: "c_real" })
    mockGetChannelType.mockResolvedValue("text")
    mockR2Get.mockResolvedValue(r2Object({ httpMetadata: { contentType: "application/pdf" } }))
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="doc.pdf"')
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
    expect(res.headers.get("Content-Range")).toBe("bytes 4-6/10")
  })

  it("human: ranged media returns 502 when the authorized R2 object is missing", async () => {
    allowPersistedHuman(persistedRow({ filename: "clip.mp4", contentType: "video/mp4", size: 10 }))
    mockR2Get.mockResolvedValue(null)

    const res = await GET(req({ Range: "bytes=0-2" }), ctx())

    expect(res.status).toBe(502)
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png", { range: { offset: 0, length: 3 } })
  })

  it("human: Range on non-media keeps the existing full attachment response", async () => {
    allowPersistedHuman(persistedRow({ filename: "doc.pdf", contentType: "application/pdf" }))
    mockR2Get.mockResolvedValue(r2Object({ httpMetadata: { contentType: "application/pdf" } }))

    const res = await GET(req({ Range: "bytes=2-4" }), ctx())

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="doc.pdf"')
    expect(res.headers.get("Accept-Ranges")).toBeNull()
    expect(res.headers.get("Content-Range")).toBeNull()
    expect(mockR2Get).toHaveBeenCalledWith("channel/c_row/uuid/a.png")
  })

  it("routes a DM-scoped row through requireDMAccess (block gate), not requireChannelMember", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow())
    mockGetMessage.mockResolvedValue({ id: "m_1", channelId: "dm_1" })
    mockGetChannelType.mockResolvedValue("dm")
    mockRequireDMAccess.mockResolvedValue({ ok: true, value: {} })
    mockR2Get.mockResolvedValue(r2Object())
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(200)
    expect(mockRequireDMAccess).toHaveBeenCalledWith({}, "dm_1", "bot_1")
    expect(mockRequireChannelMember).not.toHaveBeenCalled()
  })

  it("502 when the row exists but R2 has no object (infra drift, not enumeration)", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1" }))
    mockR2Get.mockResolvedValue(null)
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(502)
  })

  it("getAttachmentById throws → 500 JSON envelope (no binary body leak)", async () => {
    mockGetAttachmentById.mockRejectedValueOnce(new Error("d1_transient"))
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })

  it("bot: obj.arrayBuffer() throws mid-read → 500 JSON envelope, NOT a truncated 200", async () => {
    mockGetAttachmentById.mockResolvedValue(persistedRow({ messageId: null, uploaderId: "bot_1" }))
    mockR2Get.mockResolvedValue(
      r2Object({
        arrayBuffer: async () => {
          throw new Error("stream_error")
        },
      }),
    )
    const res = await GET(req({ Authorization: "Bearer crk_abc" }), ctx())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "internal error", code: "internal" })
  })
})
