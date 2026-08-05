/**
 * POST /api/community/dm/:id/upload — thin shim over the unified upload trunk.
 *
 * DMs are `type=dm` rows in the same channel id-space; the trunk's channel
 * upload handler dispatches a DM id through requireMessageSurfaceAccess (→
 * requireDMAccess, block gate) and derives kind="dm" (a DM is a legitimate
 * attachment target — no message-bearing-surface guard). Identical behavior to
 * the old dedicated dm-upload route, so this just forwards.
 */
export { POST } from "../../../channels/[id]/upload/route"
