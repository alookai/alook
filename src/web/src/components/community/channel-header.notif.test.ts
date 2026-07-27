/**
 * H3 — notif level single source.
 *
 * The channel header once declared a LOCAL `NOTIF_LEVELS` array that shadowed
 * the shared one in `@alook/shared/constants/community`. That local copy is the
 * kind of hand-rolled duplicate the A8 spelling bug hid in. These tests assert
 * the header now renders its dropdown from the shared single source and that no
 * local shadow definition remains in the file.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const headerSource = readFileSync(
  fileURLToPath(new URL("./channel-header.tsx", import.meta.url)),
  "utf8",
)

describe("channel-header notif level single source (H3)", () => {
  it("has no local NOTIF_LEVELS shadow — only the shared import survives", () => {
    // A local `const NOTIF_LEVELS = [...]` (the pre-H3 shadow) must be gone.
    expect(headerSource).not.toMatch(/(?:const|let)\s+NOTIF_LEVELS\s*[:=]/)
    // And it must pull the single source from shared.
    expect(headerSource).toMatch(/import\s*\{[^}]*\bNOTIF_LEVELS\b[^}]*\}\s*from "@alook\/shared\/constants\/community"/)
  })

  it("builds its dropdown options from the shared NOTIF_LEVELS, not raw literals", () => {
    // The channel option array must map over the shared source rather than
    // re-listing the level strings by hand.
    expect(headerSource).toMatch(/CHANNEL_NOTIF_OPTIONS[\s\S]*NOTIF_LEVELS\.map/)
    // The inherit sentinel routes through the shared constant, not a literal.
    expect(headerSource).toMatch(/USE_SERVER_DEFAULT/)
  })
})
