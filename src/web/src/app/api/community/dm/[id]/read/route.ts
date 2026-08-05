/**
 * PUT /api/community/dm/:id/read — thin shim over the unified channel trunk.
 *
 * DMs are `type=dm` rows in the same channel id-space, and the trunk's
 * `channels/[id]/read` handler routes a DM id through `requireMessageSurfaceAccess`
 * → `requireDMAccess` (block gate included), then marks read exactly as it does
 * for a channel. The per-DM read logic is therefore identical to the channel
 * path — this route just forwards, so it can be retired once callers move to
 * `channels/[id]/read`.
 *
 * Behavior note (convergence): the trunk handler's not-in-channel guard message
 * is "message not in channel" (was "lastReadMessageId does not belong to this
 * dm" here) and the mass-mark path also clears mentions in a batch — a no-op on
 * a DM (DMs carry no mention rows: mention extraction is channel/thread only,
 * message-handler.ts). Read semantics are unchanged.
 */
export { PUT } from "../../../channels/[id]/read/route"
