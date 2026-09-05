import { createLogger, queries } from "@alook/shared";
import { createAuth } from "@/lib/auth";
import { getPrimaryDb } from "@/lib/db";
import { withEnv } from "@/lib/middleware/env";
import {
  isNativeOauthAttemptId,
  nativeOauthCallbackUrls,
  nativeOauthHtml,
  nativeOauthRedirect,
} from "@/lib/native-oauth";

const log = createLogger({ service: "native-oauth/start" });

function errorPage(status: number): Response {
  return nativeOauthHtml(
    "<!doctype html><title>Sign-in unavailable</title><p>This sign-in request is unavailable.</p>",
    { status },
  );
}

export const GET = withEnv(async (request, ctx) => {
  const requestUrl = new URL(request.url);
  const baseUrl = new URL(ctx.env.BETTER_AUTH_URL);
  const attemptId = requestUrl.searchParams.get("attempt");
  if (
    requestUrl.origin !== baseUrl.origin ||
    !isNativeOauthAttemptId(attemptId)
  ) {
    return errorPage(400);
  }

  try {
    const db = getPrimaryDb(ctx.env.DB);
    const attempt = await queries.nativeOauth.claimStart(db, attemptId);
    if (!attempt) return errorPage(410);

    try {
      const result = await createAuth(ctx.env).api.signInSocial({
        body: {
          provider: attempt.provider,
          disableRedirect: true,
          ...nativeOauthCallbackUrls(ctx.env.BETTER_AUTH_URL, attempt.id),
        },
        headers: request.headers,
        returnHeaders: true,
      });
      if (!result.response.url) throw new Error("missing provider URL");
      return nativeOauthRedirect(result.response.url, result.headers);
    } catch {
      await queries.nativeOauth.failOpenedAttempt(db, attempt.id, "start_failed");
      log.warn("native OAuth provider start failed");
      return errorPage(502);
    }
  } catch {
    log.error("native OAuth start unavailable");
    return errorPage(503);
  }
});
