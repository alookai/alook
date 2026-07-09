import { describe, it, expect } from "vitest"
import { isMimeAllowed } from "./use-file-attachments"

// Pin the MIME allowlist logic against the server-side `mimeAllowed` in
// `src/web/src/lib/community/upload.ts`. Both must agree — if this fires the
// client filter and the server would still reject, users see two rejections
// for one upload; if the client accepts and server rejects, users see the
// dreaded generic "file type not allowed" 400 after the round-trip.
describe("isMimeAllowed", () => {
  const ATTACHMENT_ALLOWED = [
    "image/",
    "video/",
    "audio/",
    "application/pdf",
    "text/",
  ] as const

  it("prefix entries match by prefix", () => {
    expect(isMimeAllowed("image/png", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("image/jpeg", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("video/mp4", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("audio/mpeg", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("text/plain", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("text/markdown", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("text/csv", ATTACHMENT_ALLOWED)).toBe(true)
  })

  it("exact-match entries require full equality", () => {
    expect(isMimeAllowed("application/pdf", ATTACHMENT_ALLOWED)).toBe(true)
    // Not a prefix match — the entry is `application/pdf`, not `application/`.
    expect(isMimeAllowed("application/zip", ATTACHMENT_ALLOWED)).toBe(false)
    expect(isMimeAllowed("application/x-zip-compressed", ATTACHMENT_ALLOWED)).toBe(false)
    expect(isMimeAllowed("application/octet-stream", ATTACHMENT_ALLOWED)).toBe(false)
  })

  it("empty content-type is rejected", () => {
    // Browsers report `""` for files whose type can't be sniffed. Server
    // would 400 these too — align.
    expect(isMimeAllowed("", ATTACHMENT_ALLOWED)).toBe(false)
  })

  it("respects a bare exact-only list (no prefixes)", () => {
    const ICONS_ONLY = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
    expect(isMimeAllowed("image/png", ICONS_ONLY)).toBe(true)
    expect(isMimeAllowed("image/svg+xml", ICONS_ONLY)).toBe(false)
    expect(isMimeAllowed("video/mp4", ICONS_ONLY)).toBe(false)
  })
})
