import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { runAttachmentUpload } from "@/lib/community/upload"

// The unified attachment-upload trunk: one route, dispatched by surface inside
// runAttachmentUpload (requireMessageSurfaceAccess → kind derived from surface +
// channel.type). A DM id runs the DM block gate; a thread/forum-post id runs
// the child-surface gate — all surfaces upload through this one door.
export const POST = withAuth((req: NextRequest, ctx) => runAttachmentUpload(req, ctx))
