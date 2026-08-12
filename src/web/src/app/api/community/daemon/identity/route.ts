import { NextResponse } from "next/server"
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth"

export const GET = withCommunityDaemonAuth(async (_req, ctx) =>
  NextResponse.json({ machineId: ctx.machineId })
)
