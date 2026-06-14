import { NextRequest } from "next/server"
import { toNextJsHandler } from "better-auth/next-js"
import { createAuth } from "@/lib/auth"
import { withEnv } from "@/lib/middleware/env"

export const GET = withEnv(async (req: NextRequest, ctx) => {
  return toNextJsHandler(createAuth(ctx.env)).GET(req)
});

export const POST = withEnv(async (req: NextRequest, ctx) => {
  return toNextJsHandler(createAuth(ctx.env)).POST(req)
});
