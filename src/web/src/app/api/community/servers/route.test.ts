import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const createServer = vi.fn()
const fanOut = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})), getPrimaryDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityServer: {
        createServer: (...a: unknown[]) => createServer(...a),
        listUserServers: vi.fn(),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => fanOut(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  resolveHumanAuth: async () => ({ context: { env: { DB: {} }, userId: "u1", email: "u@t.com" } }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"
import { WS_EVENTS, ROLES, MAX_SERVER_NAME_LENGTH, MAX_SERVER_DESCRIPTION_LENGTH } from "@alook/shared"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/community/servers", () => {
  const joinedAt = "2026-07-02T00:00:00.000Z"

  beforeEach(() => {
    vi.clearAllMocks()
    fanOut.mockResolvedValue(undefined)
  })

  it("does not accept official status when creating a server", async () => {
    createServer.mockResolvedValue({
      server: { id: "srv_1", name: "New", ownerId: "u1", official: false },
      ownerMember: { id: "mem_1", userId: "u1", joinedAt, userName: "Alice", userImage: null, userAvatarVersion: 0, userDiscriminator: "0042" },
    })
    const res = await POST(postReq({ name: "New", official: true }))
    expect(res.status).toBe(201)
    expect(createServer).toHaveBeenCalledWith(expect.anything(), {
      name: "New", description: undefined, ownerId: "u1",
    })
  })

  it("fires current MEMBER_JOIN identity sourced from createServer's ownerMember", async () => {
    createServer.mockResolvedValue({
      server: { id: "srv_1", name: "My Server", ownerId: "u1" },
      ownerMember: { id: "mem_1", userId: "u1", joinedAt, userName: "Alice", userImage: null, userAvatarVersion: 0, userDiscriminator: "0042" },
    })

    const res = await POST(postReq({ name: "My Server" }))
    expect(res.status).toBe(201)

    expect(fanOut).toHaveBeenCalledTimes(1)
    expect(fanOut).toHaveBeenCalledWith("srv_1", {
      type: WS_EVENTS.MEMBER_JOIN,
      serverId: "srv_1",
      member: {
        id: "mem_1",
        userId: "u1",
        name: "Alice",
        avatar: null, avatarVersion: 0, discriminator: "0042",
        role: ROLES.OWNER,
        joinedAt,
      },
    })
  })

  it("passes ownerMember.userName straight through to member.name — no email fallback", async () => {
    // Post-migration 0050 + Better-Auth create.before hook, user.name is
    // guaranteed non-empty. The route drops the pre-migration
    // `?? ctx.email` fallback; the query layer's return type is now `string`,
    // not `string | null`. This test locks the contract in.
    createServer.mockResolvedValue({
      server: { id: "srv_2", name: "S", ownerId: "u1" },
      ownerMember: { id: "mem_2", userId: "u1", joinedAt, userName: "Bob" },
    })

    const res = await POST(postReq({ name: "S" }))
    expect(res.status).toBe(201)

    const [, payload] = fanOut.mock.calls[0]
    expect(payload.member.name).toBe("Bob")
    expect(payload.member.name).not.toContain("@")
  })

  it("returns 400 when name is missing", async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(400)
    expect(createServer).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON without creating or publishing a server", async () => {
    const response = await POST(new NextRequest("http://localhost/api/community/servers", {
      method: "POST", body: "{", headers: { "Content-Type": "application/json" },
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid request body" })
    expect(createServer).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })

  it.each(["   ", "n".repeat(MAX_SERVER_NAME_LENGTH + 1)])("rejects a blank or overlength name", async (name) => {
    const response = await POST(postReq({ name }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: `name must be 1-${MAX_SERVER_NAME_LENGTH} characters` })
    expect(createServer).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })

  it.each([null, 42, "d".repeat(MAX_SERVER_DESCRIPTION_LENGTH + 1)])("rejects an invalid description", async (description) => {
    const response = await POST(postReq({ name: "New", description }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: typeof description === "string"
      ? `description must be ≤ ${MAX_SERVER_DESCRIPTION_LENGTH} characters` : "description must be a string" })
    expect(createServer).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })

  it.each(["", "  Keep these spaces\nand this line.  ", "d".repeat(MAX_SERVER_DESCRIPTION_LENGTH)])("preserves a valid description verbatim", async (description) => {
    const server = { id: "srv_description", name: "New", description, ownerId: "u1" }
    createServer.mockResolvedValueOnce({ server,
      ownerMember: { id: "mem_description", userId: "u1", joinedAt, userName: "Alice" },
    })

    const response = await POST(postReq({ name: "New", description }))

    expect(response.status).toBe(201)
    expect(createServer).toHaveBeenCalledExactlyOnceWith({}, { name: "New", description, ownerId: "u1" })
    expect(await response.json()).toEqual({ server })
    expect(fanOut).toHaveBeenCalledOnce()
  })

  it("normalizes a spaced name via slugify before creating the server", async () => {
    createServer.mockResolvedValue({
      server: { id: "srv_1", name: "My-Home", ownerId: "u1" },
      ownerMember: { id: "mem_1", userId: "u1", joinedAt, userName: "Alice", userImage: null, userAvatarVersion: 0, userDiscriminator: "0042" },
    })

    const res = await POST(postReq({ name: "My Home" }))
    expect(res.status).toBe(201)
    expect(createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "My-Home" }),
    )
  })

  it("returns 400 (and never calls createServer) when the name is all disallowed characters", async () => {
    const res = await POST(postReq({ name: "///" }))
    expect(res.status).toBe(400)
    expect(createServer).not.toHaveBeenCalled()
    expect(fanOut).not.toHaveBeenCalled()
  })

  it("returns 201 { server } and does not leak ownerMember to the response body", async () => {
    const server = { id: "srv_x", name: "S", ownerId: "u1" }
    createServer.mockResolvedValue({
      server,
      ownerMember: { id: "mem_x", userId: "u1", joinedAt, userName: "Alice", userImage: null, userAvatarVersion: 0, userDiscriminator: "0042" },
    })

    const res = await POST(postReq({ name: "S" }))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { server: unknown; ownerMember?: unknown }
    expect(body).toEqual({ server })
    expect(body.ownerMember).toBeUndefined()
  })
})
