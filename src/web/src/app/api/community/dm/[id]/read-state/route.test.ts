import { describe, it, expect } from "vitest"
import { GET as dmReadStateGet } from "./route"
import { GET as channelReadStateGet } from "../../../channels/[id]/read-state/route"

/**
 * dm/[id]/read-state is now a thin shim that RE-EXPORTS the unified channel
 * trunk's read-state handler (DMs are `type=dm` rows in the same id-space; the
 * trunk routes a DM id through requireMessageSurfaceAccess → requireDMAccess).
 * Behavior is covered once by channels/[id]/read-state/route.test.ts — here we
 * only lock the identity so a future divergent DM handler is caught.
 */
describe("GET /api/community/dm/[id]/read-state — shim over channel trunk", () => {
  it("re-exports the channels/[id]/read-state handler (same reference)", () => {
    expect(dmReadStateGet).toBe(channelReadStateGet)
  })
})
