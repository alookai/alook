import { describe, it, expect } from "vitest"
import { POST as threadUploadPost } from "./route"
import { POST as channelUploadPost } from "../../../channels/[id]/upload/route"

/**
 * threads/[id]/upload is now a thin shim that RE-EXPORTS the unified upload
 * trunk's channel handler. A thread/forum_post id is dispatched inside
 * runAttachmentUpload (requireMessageSurfaceAccess → channel arm →
 * requireChannelMember; kind derived as "thread" via requireChildSurface).
 * Behavior is covered once by upload.test.ts (thread surface → thread/ R2
 * prefix) — here we only lock the identity so a future divergent thread upload
 * handler is caught.
 */
describe("POST /api/community/threads/[id]/upload — shim over upload trunk", () => {
  it("re-exports the channels/[id]/upload handler (same reference)", () => {
    expect(threadUploadPost).toBe(channelUploadPost)
  })
})
