import { describe, it, expect } from "vitest"
import { PUT as threadReadPut } from "./route"
import { PUT as channelReadPut } from "../../../channels/[id]/read/route"

/**
 * threads/[id]/read is now a thin shim that RE-EXPORTS the unified channel
 * trunk's read handler (a thread IS a channel; the trunk dispatches by surface).
 * The old requireChildSurface guard was a route-identity artifact, dropped as
 * redundant post-merge (see route.ts). Read behavior is covered once by
 * channels/[id]/read/route.test.ts — here we only lock the identity so a future
 * divergent thread read handler is caught.
 */
describe("PUT /api/community/threads/[id]/read — shim over channel trunk", () => {
  it("re-exports the channels/[id]/read handler (same reference)", () => {
    expect(threadReadPut).toBe(channelReadPut)
  })
})
