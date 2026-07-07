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

import {
  handleAttachmentUpload,
  handleServerIconUpload,
  runAttachmentUpload,
} from "./upload"
import { MAX_ATTACHMENT_SIZE_BYTES, MAX_SERVER_ICON_SIZE_BYTES } from "@alook/shared"

function envWithR2(put: ReturnType<typeof vi.fn>) {
  return { COMMUNITY_MEDIA: { put } } as unknown as Env
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
    ;(fd as unknown as { __file: unknown }).__file = file
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

  it("uploads an in-allowlist file under the size cap", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.key).toMatch(/^channel\/c1\/[0-9a-f-]+\/hi\.png$/)
    expect(res.url).toBe(`/api/community/media/${res.key}`)
    expect(res.contentType).toBe("image/png")
    expect(res.size).toBe(10)
    expect(put).toHaveBeenCalledOnce()
  })

  it("passes a known-length File body to R2", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const file = fakeFile("hi.png", "image/png", 10)
    await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1")
    expect(put).toHaveBeenCalledOnce()
    const [, body] = put.mock.calls[0]
    expect(body).toBe(file)
    expect(body).toMatchObject({ size: 10, type: "image/png" })
    expect(body).not.toBeInstanceOf(ReadableStream)
    expect(body).not.toBeInstanceOf(ArrayBuffer)
  })

  it("rejects when no file part is present (400)", async () => {
    const put = vi.fn()
    const res = await handleAttachmentUpload(reqWithFile(null), envWithR2(put), "channel", "c1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
  })

  it("rejects oversize files with 413", async () => {
    const put = vi.fn()
    const file = fakeFile("big.png", "image/png", MAX_ATTACHMENT_SIZE_BYTES + 1)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })

  it("rejects disallowed MIME types with 400", async () => {
    const put = vi.fn()
    const file = fakeFile("evil.exe", "application/x-msdownload", 2)
    const res = await handleAttachmentUpload(reqWithFile(file), envWithR2(put), "channel", "c1")
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.response.status).toBe(400)
    expect(put).not.toHaveBeenCalled()
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
      const res = await handleAttachmentUpload(reqWithFile(f), envWithR2(put), "dm", "d1")
      expect(res.ok).toBe(true)
    }
    expect(put).toHaveBeenCalledTimes(cases.length)
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

describe("runAttachmentUpload", () => {
  beforeEach(() => vi.clearAllMocks())

  function ctxWith(env: Env, params: Record<string, string> | undefined) {
    return {
      env,
      userId: "u1",
      email: "u@t.com",
      params,
    }
  }

  it("returns 400 when the route id param is missing", async () => {
    const put = vi.fn()
    const perm = vi.fn()
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), undefined),
      "channel",
      perm as never,
    )
    expect(res.status).toBe(400)
    expect(perm).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it("forwards permission-check failures with the reported status + error", async () => {
    const put = vi.fn()
    const perm = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      error: "forbidden",
    })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
      "channel",
      perm as never,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("forbidden")
    expect(put).not.toHaveBeenCalled()
  })

  it("hands off to handleAttachmentUpload with the resolved kind + id, returns the URL", async () => {
    // Happy path — permission passes, streaming upload succeeds, response
    // shape mirrors what the three route files used to build inline.
    const put = vi.fn().mockResolvedValue(undefined)
    const perm = vi.fn().mockResolvedValue({ ok: true, value: { id: "c1" } })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "c1" }),
      "channel",
      perm as never,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      url: string
      filename: string
      contentType: string
      size: number
    }
    expect(body.filename).toBe("hi.png")
    expect(body.contentType).toBe("image/png")
    expect(body.size).toBe(10)
    expect(body.url).toMatch(/^\/api\/community\/media\/channel\/c1\/[0-9a-f-]+\/hi\.png$/)
    expect(put).toHaveBeenCalledOnce()
    // Known-length R2 body rule applies here too — the shared helper must not
    // hand R2 an unknown-length ReadableStream or buffer into ArrayBuffer.
    const [key, streamed] = put.mock.calls[0]
    expect(key).toMatch(/^channel\/c1\//)
    expect(streamed).toMatchObject({ size: 10, type: "image/png" })
    expect(streamed).not.toBeInstanceOf(ReadableStream)
    expect(streamed).not.toBeInstanceOf(ArrayBuffer)
  })

  it("routes 'dm' kind through the dm/ R2 prefix", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const perm = vi.fn().mockResolvedValue({ ok: true, value: { id: "d1" } })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "d1" }),
      "dm",
      perm as never,
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^dm\/d1\//)
  })

  it("routes 'thread' kind through the thread/ R2 prefix", async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const perm = vi.fn().mockResolvedValue({ ok: true, value: { id: "t1" } })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("hi.png", "image/png", 10)),
      ctxWith(envWithR2(put), { id: "t1" }),
      "thread",
      perm as never,
    )
    expect(res.status).toBe(200)
    const [key] = put.mock.calls[0]
    expect(key).toMatch(/^thread\/t1\//)
  })

  it("forwards handleAttachmentUpload errors (e.g. oversize) unchanged", async () => {
    const put = vi.fn()
    const perm = vi.fn().mockResolvedValue({ ok: true, value: { id: "c1" } })
    const res = await runAttachmentUpload(
      reqWithFile(fakeFile("big.png", "image/png", MAX_ATTACHMENT_SIZE_BYTES + 1)),
      ctxWith(envWithR2(put), { id: "c1" }),
      "channel",
      perm as never,
    )
    expect(res.status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })
})
