/**
 * PUT /api/community/threads/:id/read — thin shim over the unified channel trunk.
 *
 * A thread IS a channel, so thread read is identical to channels/[id]/read (same
 * mass-mark + batched mention-clear, same 404/403 split via
 * requireMessageSurfaceAccess). This route just re-exports the channel handler,
 * to be retired once callers move to channels/[id]/read.
 *
 * The old dedicated handler additionally ran requireChildSurface (reject a
 * top-level id sent to the /threads/ URL). That guard was a ROUTE-IDENTITY
 * artifact — a formal "/threads/ only accepts children" constraint — NOT a
 * security gate; the unified trunk accepts any channel type by surface, so it's
 * redundant post-merge and dropped (Blondie #28: no per-type re-derive the trunk
 * already makes moot). The only behavioral delta — a top-level id sent to
 * /threads/read now succeeds (was 400) — is confined to this deprecated URL,
 * which has no live caller reaching it (use-eager-channel-read routes top-level
 * ids to /channels/read) and is on the delete list.
 */
export { PUT } from "../../../channels/[id]/read/route"
