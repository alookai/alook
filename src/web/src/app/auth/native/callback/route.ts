import { createLogger, queries } from "@alook/shared";
import { createAuth } from "@/lib/auth";
import { getPrimaryDb } from "@/lib/db";
import { withEnv } from "@/lib/middleware/env";
import {
  expireBrowserAnalyticsCookies,
  isNativeOauthAttemptId,
  isNativeOauthRequestTarget,
  nativeOauthHtml,
  nativeOauthRedirect,
  nativeOauthReturnUrl,
  sanitizeOauthFailure,
  sha256Hex,
} from "@/lib/native-oauth";

const log = createLogger({ service: "native-oauth/callback" });
type CallbackKind = "signin" | "signup" | "error";

function isCallbackKind(value: string | null): value is CallbackKind {
  return value === "signin" || value === "signup" || value === "error";
}

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
  const kind = requestUrl.searchParams.get("kind");
  if (
    !isNativeOauthRequestTarget(request, ctx.env.BETTER_AUTH_URL) ||
    !isNativeOauthAttemptId(attemptId) ||
    !isCallbackKind(kind)
  ) {
    return errorPage(400);
  }

  try {
    const db = getPrimaryDb(ctx.env.DB);
    const attempt = await queries.nativeOauth.getOpenedAttempt(db, attemptId);
    if (!attempt) return errorPage(410);

    if (kind === "error") {
      const failureCode = sanitizeOauthFailure(requestUrl.searchParams.get("error"));
      await queries.nativeOauth.failOpenedAttempt(db, attempt.id, failureCode);
      return nativeOauthRedirect(
        nativeOauthReturnUrl(attempt.platform, attempt.id, { status: failureCode }),
      );
    }

    try {
      const generated = await createAuth(ctx.env).api.generateOneTimeToken({
        headers: request.headers,
        returnHeaders: true,
      });
      const handoffCode = generated.response.token;
      const attached = await queries.nativeOauth.attachHandoff(db, {
        attemptId: attempt.id,
        handoffCodeHash: await sha256Hex(handoffCode),
        authKind: kind,
      });
      if (!attached) return errorPage(410);

      const responseHeaders = new Headers(generated.headers);
      expireBrowserAnalyticsCookies(
        responseHeaders,
        baseUrl.protocol === "https:",
      );
      return nativeOauthRedirect(
        nativeOauthReturnUrl(attempt.platform, attempt.id, { code: handoffCode }),
        responseHeaders,
      );
    } catch {
      await queries.nativeOauth.failOpenedAttempt(
        db,
        attempt.id,
        "oauth_callback_failed",
      );
      log.warn("native OAuth handoff generation failed");
      return nativeOauthRedirect(
        nativeOauthReturnUrl(attempt.platform, attempt.id, {
          status: "oauth_callback_failed",
        }),
      );
    }
  } catch {
    log.error("native OAuth callback unavailable");
    return errorPage(503);
  }
});
