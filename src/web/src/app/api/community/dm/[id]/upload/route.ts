import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { requireDMParticipant } from "@/lib/community/permissions"
import { runAttachmentUpload } from "@/lib/community/upload"

export const POST = withAuth((req: NextRequest, ctx) =>
  runAttachmentUpload(req, ctx, "dm", requireDMParticipant),
)
