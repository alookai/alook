import { withAuth } from "@/lib/middleware/auth-policy"
import { NextResponse } from "next/server"
import { machineAuthPolicy } from "@/lib/middleware/community-daemon-auth"

export const GET = withAuth(machineAuthPolicy, async (_req, ctx) =>
  NextResponse.json({ machineId: ctx.machineId }))
