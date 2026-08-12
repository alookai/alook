import { beforeEach, describe, expect, it, vi } from "vitest"

const getAttachmentById = vi.fn()
const getMessage = vi.fn()
const getChannelType = vi.fn()
const requireChannelMember = vi.fn()
const requireDMAccess = vi.fn()

vi.mock("@alook/shared", () => ({
  queries: {
    communityAttachment: { getAttachmentById: (...args: unknown[]) => getAttachmentById(...args) },
    communityMessage: { getMessage: (...args: unknown[]) => getMessage(...args) },
    communityChannel: { getChannelType: (...args: unknown[]) => getChannelType(...args) },
  },
}))
vi.mock("./permissions", () => ({
  requireChannelMember: (...args: unknown[]) => requireChannelMember(...args),
  requireDMAccess: (...args: unknown[]) => requireDMAccess(...args),
}))

import { authorizeAttachment } from "./attachment-authorization"

const db = {} as any
const actor = { kind: "human", userId: "u1", email: "u@example.test", isBot: false } as any
const row = { id: "a1", messageId: "m1", uploaderId: "u2", targetId: "routing-only" }

describe("authorizeAttachment", () => {
  beforeEach(() => vi.clearAllMocks())

  it("allows only the uploader for a pending row", async () => {
    getAttachmentById.mockResolvedValue({ ...row, messageId: null, uploaderId: "u1" })
    expect((await authorizeAttachment(actor, db, "a1")).ok).toBe(true)
    getAttachmentById.mockResolvedValue({ ...row, messageId: null, uploaderId: "u2" })
    expect((await authorizeAttachment(actor, db, "a1")).ok).toBe(false)
  })

  it("authorizes persisted channel rows from the message channel", async () => {
    getAttachmentById.mockResolvedValue(row)
    getMessage.mockResolvedValue({ id: "m1", channelId: "actual-channel" })
    getChannelType.mockResolvedValue("text")
    requireChannelMember.mockResolvedValue({ ok: true })
    expect((await authorizeAttachment(actor, db, "a1")).ok).toBe(true)
    expect(requireChannelMember).toHaveBeenCalledWith(db, "actual-channel", "u1")
  })

  it("uses the DM access gate for persisted DM rows", async () => {
    getAttachmentById.mockResolvedValue(row)
    getMessage.mockResolvedValue({ id: "m1", channelId: "dm1" })
    getChannelType.mockResolvedValue("dm")
    requireDMAccess.mockResolvedValue({ ok: false })
    expect((await authorizeAttachment(actor, db, "a1")).ok).toBe(false)
    expect(requireDMAccess).toHaveBeenCalledWith(db, "dm1", "u1")
    expect(requireChannelMember).not.toHaveBeenCalled()
  })
})
