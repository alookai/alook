import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { runAttachmentUpload } from "@/lib/community/upload"

// Access via the unified id-in-path gate (not bare requireChannelMember): for a
// DM id it runs the DM block check, closing the incidental P0 where a
// blocked-but-still-DM-member could upload to a DM through this channel route.
// A DM id is still rejected as a non-message-bearing channel surface downstream
// (runAttachmentUpload's channel-kind requireMessageBearingSurface), so the
// block gate is the meaningful add here.
export const POST = withAuth((req: NextRequest, ctx) =>
  runAttachmentUpload(req, ctx, "channel", requireMessageSurfaceAccess),
)
