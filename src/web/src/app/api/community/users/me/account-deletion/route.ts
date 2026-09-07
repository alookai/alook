import { NextResponse } from "next/server"
import { z } from "zod"
import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import {
  restoreVerifiedDeletionCode,
  verifyDeletionCode,
} from "@/lib/account-deletion/challenge"
import { executeAccountDeletion } from "@/lib/account-deletion/execution"

const bodySchema = z.object({
  otp: z.string().regex(/^\d{6}$/u),
}).strict()

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store, max-age=0" } },
  )
}

function clearAuthCookies(response: NextResponse): void {
  for (const name of ["better-auth.session_token", "better-auth.session_data"]) {
    response.cookies.set(name, "", { maxAge: 0, path: "/" })
    response.cookies.set(`__Secure-${name}`, "", { maxAge: 0, path: "/", secure: true })
  }
}

export const POST = withCookieHumanAuth(async (request, context) => {
  let input: z.infer<typeof bodySchema>
  try {
    input = bodySchema.parse(await request.json())
  } catch {
    return errorResponse("INVALID_OTP", 400)
  }

  const db = getPrimaryDb(context.env.DB)
  const verification = await verifyDeletionCode(db, {
    userId: context.userId,
    email: context.email,
    otp: input.otp,
  })
  if (verification.kind === "invalid") return errorResponse("INVALID_OTP", 400)
  if (verification.kind === "expired") return errorResponse("OTP_EXPIRED", 400)
  if (verification.kind === "too_many_attempts") {
    return errorResponse("TOO_MANY_ATTEMPTS", 403)
  }

  const deletion = await executeAccountDeletion(
    db,
    context.env,
    context.executionContext,
    context.userId,
  )
  if (deletion.kind === "failed") {
    const liveUser = await getPrimaryDb(context.env.DB)
      .query.user.findFirst({ where: (row, { eq }) => eq(row.id, context.userId) })
      .catch(() => null)
    if (liveUser) {
      await restoreVerifiedDeletionCode(
        getPrimaryDb(context.env.DB),
        verification.challenge,
      ).catch(() => {})
    }
    return errorResponse("ACCOUNT_DELETION_FAILED", 503)
  }

  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  )
  clearAuthCookies(response)
  try {
    const signOut = await createAuth(context.env).api.signOut({
      headers: request.headers,
      returnHeaders: true,
    }) as { headers: Headers }
    for (const cookie of signOut.headers.getSetCookie()) {
      response.headers.append("Set-Cookie", cookie)
    }
  } catch {}
  return response
})
