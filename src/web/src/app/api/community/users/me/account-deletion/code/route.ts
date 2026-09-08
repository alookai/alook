import { withCookieHumanAuth } from "@/lib/middleware/auth"
import { getPrimaryDb } from "@/lib/db"
import { sendDeletionCode } from "@/lib/account-deletion/challenge"

export const POST = withCookieHumanAuth(async (_request, context) => {
  const result = await sendDeletionCode(getPrimaryDb(context.env.DB), context.env, {
    userId: context.userId,
    email: context.email,
  })

  if (result.kind === "rate_limited") {
    return Response.json(
      { error: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Retry-After": String(result.retryAfter),
        },
      },
    )
  }
  if (result.kind === "send_failed") {
    return Response.json(
      { error: "CODE_SEND_FAILED" },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    )
  }
  return Response.json(
    {
      ok: true,
      expires_in: result.expiresIn,
      resend_after: result.resendAfter,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  )
})
