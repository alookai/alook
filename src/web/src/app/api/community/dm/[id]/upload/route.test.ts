import { describe, it, expect } from "vitest"
import { POST as dmUploadPost } from "./route"
import { POST as channelUploadPost } from "../../../channels/[id]/upload/route"

/**
 * dm/[id]/upload is now a thin shim that RE-EXPORTS the unified upload trunk's
 * channel handler. A DM id is dispatched inside runAttachmentUpload
 * (requireMessageSurfaceAccess → dm arm → requireDMAccess block gate, kind
 * derived as "dm"). Behavior is covered once by upload.test.ts's dispatch cases
 * (dm surface → dm/ R2 prefix, block gate) — here we only lock the identity so a
 * future divergent DM upload handler is caught.
 */
describe("POST /api/community/dm/[id]/upload — shim over upload trunk", () => {
  it("re-exports the channels/[id]/upload handler (same reference)", () => {
    expect(dmUploadPost).toBe(channelUploadPost)
  })
})
