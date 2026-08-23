import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetServer = vi.fn()
const mockUpdateServerIconIfCurrent = vi.fn()
const mockGetMember = vi.fn()
const mockHandleServerIconUpload = vi.fn()
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))

const mediaGet = vi.fn()
const mediaDelete = vi.fn()
const mediaList = vi.fn()
const mediaPut = vi.fn()
const mockWaitUntil = vi.fn<(promise: Promise<unknown>) => void>()
const mockGetCloudflareContext = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...a),
}))

function cloudflareContext() {
  return {
    env: {
      DB: {},
      COMMUNITY_MEDIA: {
        get: (...a: unknown[]) => mediaGet(...a),
        put: (...a: unknown[]) => mediaPut(...a),
        delete: (...a: unknown[]) => mediaDelete(...a),
        list: (...a: unknown[]) => mediaList(...a),
      },
    },
    ctx: { waitUntil: (p: Promise<unknown>) => mockWaitUntil(p) },
  }
}

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({ warn }),
    queries: {
      communityServer: {
        getServer: (...a: unknown[]) => mockGetServer(...a),
        updateServerIconIfCurrent: (...a: unknown[]) => mockUpdateServerIconIfCurrent(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
      },
    },
  }
})

vi.mock("@/lib/community/upload", () => ({
  handleServerIconUpload: (...a: unknown[]) => mockHandleServerIconUpload(...a),
}))

// Flip between "authed" and "anonymous" per test to exercise `withAuth`.
let isAuthed = true

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: {
        DB: {},
        COMMUNITY_MEDIA: {
          get: (...a: unknown[]) => mediaGet(...a),
          put: (...a: unknown[]) => mediaPut(...a),
          delete: (...a: unknown[]) => mediaDelete(...a),
          list: (...a: unknown[]) => mediaList(...a),
        },
      },
      userId: "u1",
      email: "u@t.com",
      params,
    })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET, POST } from "./route"

function getReq() {
  return new NextRequest("http://localhost/api/community/servers/s1/icon", { method: "GET" })
}
function postReq() {
  return new NextRequest("http://localhost/api/community/servers/s1/icon", { method: "POST" })
}
function ctx() {
  return { params: Promise.resolve({ id: "s1" }) } as any
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe("GET /api/community/servers/[id]/icon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWaitUntil.mockReset()
    mockGetCloudflareContext.mockReset()
    mockGetCloudflareContext.mockResolvedValue(cloudflareContext())
    isAuthed = true
    mockGetServer.mockResolvedValue({ id: "s1", icon: "server-icon/s1/abc" })
    mediaGet.mockResolvedValue({
      body: new ReadableStream(),
      httpMetadata: { contentType: "image/webp" },
    })
  })

  it("returns 401 for anonymous callers", async () => {
    isAuthed = false
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(401)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("serves the icon by direct R2 key (no LIST)", async () => {
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/webp")
    expect(mediaGet).toHaveBeenCalledWith("server-icon/s1/abc")
    expect(mediaList).not.toHaveBeenCalled()
  })

  it("returns 200 for any authed user (no membership check)", async () => {
    // The route intentionally does not gate by membership — mirrors
    // `media/[...key]` treatment of `server-icon`.
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(200)
    expect(mockGetMember).not.toHaveBeenCalled()
  })

  it("returns 404 when the server row has no icon key", async () => {
    mockGetServer.mockResolvedValue({ id: "s1", icon: null })
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(404)
    expect(mediaGet).not.toHaveBeenCalled()
  })

  it("returns 404 when the R2 object is missing", async () => {
    mediaGet.mockResolvedValue(null)
    const res = await GET(getReq(), ctx())
    expect(res.status).toBe(404)
  })
})

describe("POST /api/community/servers/[id]/icon", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", role: "owner" })
    mockGetServer.mockResolvedValue({ id: "s1", icon: null })
    mockUpdateServerIconIfCurrent.mockImplementation(async (_db, input) => ({
      id: input.serverId,
      icon: input.nextIcon,
    }))
    mockHandleServerIconUpload.mockResolvedValue({
      ok: true,
      id: "new-id",
      key: "server-icon/s1/new-id",
      url: "/api/community/media/server-icon/s1/new-id",
      filename: "icon.png",
      contentType: "image/png",
      size: 100,
    })
    mediaDelete.mockResolvedValue(undefined)
  })

  it("stores the R2 key (not a URL) into communityServer.icon", async () => {
    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toBe("/api/community/servers/s1/icon")

    expect(mockUpdateServerIconIfCurrent).toHaveBeenCalledTimes(1)
    expect(mockUpdateServerIconIfCurrent).toHaveBeenCalledWith(expect.anything(), {
      serverId: "s1",
      expectedIcon: null,
      nextIcon: "server-icon/s1/new-id",
    })
  })

  it("returns 500 without uploading or mutating D1 when execution context acquisition fails", async () => {
    mockGetCloudflareContext.mockRejectedValueOnce(new Error("context unavailable"))

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(500)
    expect(mockHandleServerIconUpload).not.toHaveBeenCalled()
    expect(mockUpdateServerIconIfCurrent).not.toHaveBeenCalled()
  })

  it("deletes the previous R2 object exactly once when replacing an icon", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)

    expect(mediaDelete).toHaveBeenCalledTimes(1)
    expect(mediaDelete).toHaveBeenCalledWith(["server-icon/s1/old"])
  })

  it("wraps the previous R2 key delete in ctx.waitUntil", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)

    // The delete must be handed to waitUntil so the CF runtime keeps the
    // isolate alive past the response — otherwise the R2 delete can be killed
    // mid-flight.
    expect(mockWaitUntil).toHaveBeenCalledTimes(1)
    const promise = mockWaitUntil.mock.calls[0][0]
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).resolves.toBeUndefined()
    expect(mediaDelete).toHaveBeenCalledWith(["server-icon/s1/old"])
  })

  it("keeps a successful replacement committed when old-key cleanup rejects", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
    mediaDelete.mockRejectedValueOnce(new Error("secret provider detail"))

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(200)
    await expect(mockWaitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith("community_server_icon_cleanup_failed", {
      serverId: "s1",
      phase: "old_key_cleanup",
      keyCount: 1,
      errorCategory: "Error",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })

  it("keeps a successful replacement committed when waitUntil throws synchronously", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
    mockWaitUntil.mockImplementationOnce(() => {
      throw new TypeError("secret registration detail")
    })

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(200)
    expect(mockUpdateServerIconIfCurrent).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith("community_server_icon_cleanup_failed", {
      serverId: "s1",
      phase: "old_key_cleanup",
      keyCount: 1,
      errorCategory: "TypeError",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })

  it("does not call waitUntil when there is no previous key to delete", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: null })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    expect(mockWaitUntil).not.toHaveBeenCalled()
    expect(mediaDelete).not.toHaveBeenCalled()
  })

  it.each([
    "/api/community/servers/s1/icon",
    "server-icon/other/old",
    "server-icon/s1/nested/old",
    "server-icon/s1/",
  ])("does not delete a non-owned previous value %s", async (previous) => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: previous })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    expect(mediaDelete).not.toHaveBeenCalled()
  })

  it("does not delete when the new key equals the previous key", async () => {
    mockGetServer.mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/new-id" })

    const res = await POST(postReq(), ctx())
    expect(res.status).toBe(200)
    expect(mediaDelete).not.toHaveBeenCalled()
  })

  it("CAS loss with a deleted server compensates only the just-put key and returns 404", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockResolvedValueOnce(null)
    mockUpdateServerIconIfCurrent.mockResolvedValue(null)

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(404)
    expect(mediaDelete).toHaveBeenCalledTimes(1)
    expect(mediaDelete).toHaveBeenCalledWith(["server-icon/s1/new-id"])
    expect(mediaDelete).not.toHaveBeenCalledWith(expect.arrayContaining(["server-icon/s1/old"]))
  })

  it("CAS loss to another live key compensates only the just-put key and returns 409", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/winner" })
    mockUpdateServerIconIfCurrent.mockResolvedValue(null)

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "server icon changed; retry" })
    expect(mediaDelete).toHaveBeenCalledTimes(1)
    expect(mediaDelete).toHaveBeenCalledWith(["server-icon/s1/new-id"])
  })

  it("CAS loss never deletes the current winner when it equals the just-put key", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/new-id" })
    mockUpdateServerIconIfCurrent.mockResolvedValue(null)

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(409)
    expect(mediaDelete).not.toHaveBeenCalled()
  })

  it("defensively returns 409 and compensates when a live row still has expectedIcon", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
    mockUpdateServerIconIfCurrent.mockResolvedValue(null)

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(409)
    expect(mediaDelete).toHaveBeenCalledTimes(1)
    expect(mediaDelete).toHaveBeenCalledWith(["server-icon/s1/new-id"])
  })

  it("keeps the frozen 409 when compensation fails and logs no raw detail or key", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/winner" })
    mockUpdateServerIconIfCurrent.mockResolvedValue(null)
    mediaDelete.mockRejectedValueOnce(new Error("secret/key provider detail"))

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(409)
    expect(warn).toHaveBeenCalledWith("community_server_icon_cleanup_failed", {
      serverId: "s1",
      phase: "cas_compensation",
      keyCount: 1,
      errorCategory: "Error",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret/key")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("provider detail")
  })

  it("compensates a just-put key when the CAS query throws before rethrowing", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
    mockUpdateServerIconIfCurrent.mockRejectedValueOnce(new Error("d1 failed"))

    await expect(POST(postReq(), ctx())).rejects.toThrow("d1 failed")
    expect(mediaDelete).toHaveBeenCalledWith(["server-icon/s1/new-id"])
  })

  it("does not risk deleting an ambiguous winner when the CAS and verification read both throw", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockRejectedValueOnce(new Error("verification unavailable"))
    mockUpdateServerIconIfCurrent.mockRejectedValueOnce(new Error("ambiguous d1 failure"))

    await expect(POST(postReq(), ctx())).rejects.toThrow("ambiguous d1 failure")
    expect(mediaDelete).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("community_server_icon_cas_state_verification_failed", {
      serverId: "s1",
      phase: "cas_error_verification",
      objectState: "retained_unverified",
      errorCategory: "Error",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("verification unavailable")
  })

  it("retains an unverified CAS=0 upload and emits one sanitized state warning", async () => {
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: "server-icon/s1/old" })
      .mockRejectedValueOnce(new TypeError("secret verification provider detail"))
    mockUpdateServerIconIfCurrent.mockResolvedValueOnce(null)

    const res = await POST(postReq(), ctx())

    expect(res.status).toBe(500)
    expect(mediaDelete).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("community_server_icon_cas_state_verification_failed", {
      serverId: "s1",
      phase: "cas_zero_verification",
      objectState: "retained_unverified",
      errorCategory: "TypeError",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("provider detail")
  })

  it("linearizes concurrent replacements when the first upload wins", async () => {
    let liveIcon = "server-icon/s1/old"
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: liveIcon })
      .mockResolvedValueOnce({ id: "s1", icon: liveIcon })
      .mockImplementation(async () => ({ id: "s1", icon: liveIcon }))
    mockHandleServerIconUpload
      .mockResolvedValueOnce({ ok: true, key: "server-icon/s1/b" })
      .mockResolvedValueOnce({ ok: true, key: "server-icon/s1/c" })
    mockUpdateServerIconIfCurrent.mockImplementation(async (_db, input) => {
      if (liveIcon !== input.expectedIcon) return null
      liveIcon = input.nextIcon
      return { id: input.serverId, icon: input.nextIcon }
    })

    const [first, second] = await Promise.all([POST(postReq(), ctx()), POST(postReq(), ctx())])

    expect([first.status, second.status]).toEqual([200, 409])
    expect(liveIcon).toBe("server-icon/s1/b")
    await Promise.all(mockWaitUntil.mock.calls.map(([promise]) => promise))
    expect(mediaDelete.mock.calls.map(([keys]) => keys)).toEqual(expect.arrayContaining([
      ["server-icon/s1/old"],
      ["server-icon/s1/c"],
    ]))
    expect(mediaDelete).not.toHaveBeenCalledWith(["server-icon/s1/b"])
  })

  it("linearizes concurrent replacements when the second upload wins", async () => {
    let liveIcon = "server-icon/s1/old"
    const releaseFirstCas = deferred()
    mockGetServer
      .mockResolvedValueOnce({ id: "s1", icon: liveIcon })
      .mockResolvedValueOnce({ id: "s1", icon: liveIcon })
      .mockImplementation(async () => ({ id: "s1", icon: liveIcon }))
    mockHandleServerIconUpload
      .mockResolvedValueOnce({ ok: true, key: "server-icon/s1/b" })
      .mockResolvedValueOnce({ ok: true, key: "server-icon/s1/c" })
    let casCall = 0
    mockUpdateServerIconIfCurrent.mockImplementation(async (_db, input) => {
      casCall += 1
      if (casCall === 1) await releaseFirstCas.promise
      if (liveIcon !== input.expectedIcon) return null
      liveIcon = input.nextIcon
      releaseFirstCas.resolve()
      return { id: input.serverId, icon: input.nextIcon }
    })

    const [first, second] = await Promise.all([POST(postReq(), ctx()), POST(postReq(), ctx())])

    expect([first.status, second.status]).toEqual([409, 200])
    expect(liveIcon).toBe("server-icon/s1/c")
    await Promise.all(mockWaitUntil.mock.calls.map(([promise]) => promise))
    expect(mediaDelete.mock.calls.map(([keys]) => keys)).toEqual(expect.arrayContaining([
      ["server-icon/s1/old"],
      ["server-icon/s1/b"],
    ]))
    expect(mediaDelete).not.toHaveBeenCalledWith(["server-icon/s1/c"])
  })
})
