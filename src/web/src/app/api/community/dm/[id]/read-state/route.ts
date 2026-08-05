/**
 * GET /api/community/dm/:id/read-state — thin shim over the unified channel trunk.
 *
 * DMs are `type=dm` rows in the same channel id-space, and the trunk's
 * `channels/[id]/read-state` handler routes a DM id through
 * `requireMessageSurfaceAccess` → `requireDMAccess`, then reads the same
 * `getReadState` snapshot with the same response shape. Identical behavior —
 * this route just forwards, to be retired once callers move to
 * `channels/[id]/read-state`.
 *
 * Access-contract note (convergence + P0): the old DM route used
 * `requireDMAccess` directly, which collapses unknown-DM and non-participant
 * both to 404. The trunk's dispatch keeps that (DM arm → requireDMAccess, its
 * 404 rewritten to the opaque "not found" so it can't be told apart from an
 * unknown id) AND adds the block gate the old channel path lacked.
 */
export { GET } from "../../../channels/[id]/read-state/route"
