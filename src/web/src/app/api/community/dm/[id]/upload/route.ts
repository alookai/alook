import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { requireDMParticipant } from "@/lib/community/permissions"
import { runAttachmentUpload } from "@/lib/community/upload"

export const POST = withCommunityActor((req: NextRequest, ctx) =>
  runAttachmentUpload(req, ctx, "dm", requireDMParticipant),
)
