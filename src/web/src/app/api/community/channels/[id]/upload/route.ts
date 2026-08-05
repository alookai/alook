import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { runAttachmentUpload } from "@/lib/community/upload"

// The unified attachment-upload trunk: one route, dispatched by surface inside
// runAttachmentUpload (requireMessageSurfaceAccess → kind derived from surface +
// channel.type). A DM id runs the DM block gate; dm/[id]/upload and
// threads/[id]/upload are thin shims that re-export this handler.
export const POST = withAuth((req: NextRequest, ctx) => runAttachmentUpload(req, ctx))
