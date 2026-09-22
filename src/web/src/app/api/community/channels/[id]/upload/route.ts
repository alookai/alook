import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { runAttachmentUpload } from "@/lib/community/upload"

// The unified attachment-upload trunk: one route, dispatched by surface inside
// runAttachmentUpload (communication surface access → kind derived from
// surface + channel.type). A DM id runs the block + accepted-friend gate; a
// child-thread id runs the child-surface gate — all surfaces use one door.
export const POST = withAuth((req: NextRequest, ctx) => runAttachmentUpload(req, ctx))
