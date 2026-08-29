import { beforeEach, describe, expect, it } from "vitest"
import {
  appendComposerAttachmentSession,
  clearComposerAttachmentSession,
  COMPOSER_ATTACHMENT_SESSION_MAX_BYTES,
  COMPOSER_ATTACHMENT_SESSION_TTL_MS,
  getComposerAttachmentSessionStats,
  readComposerAttachmentSession,
  removeComposerAttachmentSessionFiles,
  resetComposerAttachmentSessionsForTest,
  transferComposerAttachmentSession,
} from "./composer-attachment-session"

function file(name: string, size = 1, type = "application/octet-stream") {
  return {
    name,
    size,
    type,
    lastModified: 123,
  } as File
}

describe("composer attachment same-tab session", () => {
  beforeEach(() => resetComposerAttachmentSessionsForTest())

  it("preserves stable IDs, File identity, metadata, order, and strict scopes", () => {
    const image = file("image.png", 4, "image/png")
    const document = file("notes.txt", 6, "text/plain")
    appendComposerAttachmentSession("server/channel", [
      { draftId: "image", file: image },
      { draftId: "document", file: document },
    ], 10)
    appendComposerAttachmentSession("dm/person", [
      { draftId: "dm", file: file("dm.pdf", 3, "application/pdf") },
    ], 11)

    const channel = readComposerAttachmentSession("server/channel", 12)
    expect(channel).toEqual([
      { draftId: "image", file: image },
      { draftId: "document", file: document },
    ])
    expect(channel[0].file).toBe(image)
    expect(channel[0].file).toMatchObject({
      name: "image.png",
      size: 4,
      type: "image/png",
      lastModified: 123,
    })
    expect(readComposerAttachmentSession("server/thread", 12)).toEqual([])
    expect(readComposerAttachmentSession("dm/person", 12)).toHaveLength(1)
  })

  it("removes exact IDs, deletes empty scopes, transfers once, and clears accounting", () => {
    const first = file("first", 4)
    const second = file("second", 6)
    appendComposerAttachmentSession("scope", [
      { draftId: "first", file: first },
      { draftId: "second", file: second },
    ], 1)
    expect(getComposerAttachmentSessionStats()).toEqual({ scopes: 1, bytes: 10 })

    removeComposerAttachmentSessionFiles("scope", ["first"], 2)
    expect(readComposerAttachmentSession("scope", 3)).toEqual([
      { draftId: "second", file: second },
    ])
    expect(transferComposerAttachmentSession("scope")).toEqual([
      { draftId: "second", file: second },
    ])
    expect(transferComposerAttachmentSession("scope")).toEqual([])
    expect(getComposerAttachmentSessionStats()).toEqual({ scopes: 0, bytes: 0 })

    appendComposerAttachmentSession("scope", [{ draftId: "again", file: first }], 4)
    clearComposerAttachmentSession("scope")
    expect(getComposerAttachmentSessionStats()).toEqual({ scopes: 0, bytes: 0 })
  })

  it("expires idle scopes before restore", () => {
    appendComposerAttachmentSession("old", [{ draftId: "old", file: file("old") }], 1)
    expect(readComposerAttachmentSession("old", COMPOSER_ATTACHMENT_SESSION_TTL_MS + 1)).toEqual([])
    expect(getComposerAttachmentSessionStats()).toEqual({ scopes: 0, bytes: 0 })
  })

  it("expires first, then evicts inactive LRU scopes while protecting a legal active draft", () => {
    const mib = 1024 * 1024
    appendComposerAttachmentSession("expired", [
      { draftId: "expired", file: file("expired", 1) },
    ], 0)
    appendComposerAttachmentSession("recent-a", [
      { draftId: "a", file: file("a", 4 * mib) },
    ], COMPOSER_ATTACHMENT_SESSION_TTL_MS - 2)
    appendComposerAttachmentSession("recent-b", [
      { draftId: "b", file: file("b", 4 * mib) },
    ], COMPOSER_ATTACHMENT_SESSION_TTL_MS - 1)

    const activeFiles = Array.from({ length: 10 }, (_, index) => ({
      draftId: `active-${index}`,
      file: file(`active-${index}`, 25 * mib),
    }))
    const result = appendComposerAttachmentSession(
      "active",
      activeFiles,
      COMPOSER_ATTACHMENT_SESSION_TTL_MS,
    )

    expect(result).toEqual({ accepted: true, evictedScopes: 2 })
    expect(readComposerAttachmentSession("active", COMPOSER_ATTACHMENT_SESSION_TTL_MS + 1))
      .toEqual(activeFiles)
    expect(readComposerAttachmentSession("recent-a", COMPOSER_ATTACHMENT_SESSION_TTL_MS + 1)).toEqual([])
    expect(readComposerAttachmentSession("recent-b", COMPOSER_ATTACHMENT_SESSION_TTL_MS + 1)).toHaveLength(1)
    expect(getComposerAttachmentSessionStats()).toEqual({
      scopes: 2,
      bytes: 254 * mib,
    })
  })

  it("rejects only an independently oversized active scope without evicting inactive work", () => {
    const existing = file("existing", 1)
    appendComposerAttachmentSession("inactive", [{ draftId: "keep", file: existing }], 1)
    const result = appendComposerAttachmentSession("active", [{
      draftId: "too-large",
      file: file("too-large", COMPOSER_ATTACHMENT_SESSION_MAX_BYTES + 1),
    }], 2)

    expect(result).toEqual({ accepted: false, evictedScopes: 0 })
    expect(readComposerAttachmentSession("inactive", 3)).toEqual([
      { draftId: "keep", file: existing },
    ])
  })
})
