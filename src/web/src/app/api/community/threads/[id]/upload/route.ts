/**
 * POST /api/community/threads/:id/upload — thin shim over the unified upload trunk.
 *
 * A thread is a `type=thread` (or forum_post) child channel in the same
 * id-space; the trunk's channel upload handler dispatches it through
 * requireMessageSurfaceAccess (→ requireChannelMember, the thread inherits its
 * parent's audience) and derives kind="thread" (requireChildSurface). Identical
 * behavior to the old dedicated thread-upload route, so this just forwards.
 */
export { POST } from "../../../channels/[id]/upload/route"
