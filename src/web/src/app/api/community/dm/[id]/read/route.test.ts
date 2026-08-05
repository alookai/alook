import { describe, it, expect } from "vitest"
import { PUT as dmReadPut } from "./route"
import { PUT as channelReadPut } from "../../../channels/[id]/read/route"

/**
 * dm/[id]/read is now a thin shim that RE-EXPORTS the unified channel trunk's
 * read handler (DMs are `type=dm` rows in the same id-space; the trunk routes a
 * DM id through requireMessageSurfaceAccess → requireDMAccess). So the honest
 * contract to lock is identity: the DM route serves the exact same handler as
 * the channel route — the per-DM read BEHAVIOR is covered once, by
 * channels/[id]/read/route.test.ts, not duplicated here. If someone gives the
 * DM route its own divergent handler again, this reference check fails.
 */
describe("PUT /api/community/dm/[id]/read — shim over channel trunk", () => {
  it("re-exports the channels/[id]/read handler (same reference, no divergent logic)", () => {
    expect(dmReadPut).toBe(channelReadPut)
  })
})
