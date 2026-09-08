import { describe, expect, it, vi } from "vitest"
import {
  deleteAccountStorage,
  exclusiveEmailAttachmentKeys,
  listAccountDeletionPrefix,
} from "./storage"

describe("account deletion storage", () => {
  it("keeps shared draft objects and rejects untrusted keys", () => {
    expect(exclusiveEmailAttachmentKeys([
      JSON.stringify([
        { key: "emails/drafts/a/private.txt" },
        { key: "emails/drafts/a/shared.txt" },
        { key: "server-icon/foreign/value" },
        { key: "emails/drafts/../foreign" },
      ]),
    ], [JSON.stringify([{ key: "emails/drafts/a/shared.txt" }])])).toEqual([
      "emails/drafts/a/private.txt",
    ])
  })

  it("paginates prefix listings", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ objects: [{ key: "a/1" }], truncated: true, cursor: "next" })
      .mockResolvedValueOnce({ objects: [{ key: "a/2" }], truncated: false })

    await expect(listAccountDeletionPrefix({ list }, "a/")).resolves.toEqual(["a/1", "a/2"])
    expect(list).toHaveBeenNthCalledWith(2, { prefix: "a/", cursor: "next" })
  })

  it("deletes all three bucket snapshots synchronously", async () => {
    const mediaDelete = vi.fn().mockResolvedValue(undefined)
    const emailDelete = vi.fn().mockResolvedValue(undefined)
    const bugDelete = vi.fn().mockResolvedValue(undefined)
    const env = {
      COMMUNITY_MEDIA: {
        list: vi.fn().mockResolvedValue({ objects: [{ key: "user-avatar/u/objects/old" }], truncated: false }),
        delete: mediaDelete,
      },
      EMAIL_BUCKET: {
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        delete: emailDelete,
      },
      BUG_REPORTS: {
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        delete: bugDelete,
      },
    }
    const snapshot = {
      media: {
        communityExactKeys: ["user-avatar/u"],
        communityPrefixes: ["user-avatar/u/"],
        emailExactKeys: ["emails/e/raw"],
        emailPrefixes: [],
        deletingEmailAttachments: [JSON.stringify([{ key: "emails/drafts/d/a.txt" }])],
        survivingEmailAttachments: [],
        bugReportExactKeys: ["bug-reports/u/r.gz"],
        bugReportPrefixes: [],
      },
    } as Parameters<typeof deleteAccountStorage>[1]

    await deleteAccountStorage(env as Parameters<typeof deleteAccountStorage>[0], snapshot)
    expect(mediaDelete).toHaveBeenCalledWith([
      "user-avatar/u",
      "user-avatar/u/objects/old",
    ])
    expect(emailDelete).toHaveBeenCalledWith(["emails/e/raw", "emails/drafts/d/a.txt"])
    expect(bugDelete).toHaveBeenCalledWith(["bug-reports/u/r.gz"])
  })

  it("aborts later buckets after a synchronous R2 failure", async () => {
    const env = {
      COMMUNITY_MEDIA: {
        list: vi.fn().mockRejectedValue(new Error("unavailable")),
        delete: vi.fn(),
      },
      EMAIL_BUCKET: { list: vi.fn(), delete: vi.fn() },
      BUG_REPORTS: { list: vi.fn(), delete: vi.fn() },
    }
    const snapshot = {
      media: {
        communityExactKeys: [],
        communityPrefixes: ["user-avatar/u/"],
        emailExactKeys: [],
        emailPrefixes: [],
        deletingEmailAttachments: [],
        survivingEmailAttachments: [],
        bugReportExactKeys: [],
        bugReportPrefixes: [],
      },
    } as Parameters<typeof deleteAccountStorage>[1]

    await expect(deleteAccountStorage(
      env as Parameters<typeof deleteAccountStorage>[0],
      snapshot,
    )).rejects.toThrow("unavailable")
    expect(env.EMAIL_BUCKET.list).not.toHaveBeenCalled()
  })
})
