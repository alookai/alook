import { createLogger, queries } from "@alook/shared";
import { createAuth } from "@/lib/auth";
import { getPrimaryDb } from "@/lib/db";
import { withEnv } from "@/lib/middleware/env";
import {
  copySetCookieHeaders,
  nativeOauthExchangeSchema,
  nativeOauthJson,
  parseNativeOauthJson,
  pkceChallenge,
  setWebViewAnalyticsCookie,
  sha256Hex,
} from "@/lib/native-oauth";

const log = createLogger({ service: "native-oauth/exchange" });

export const POST = withEnv(async (request, ctx) => {
  const parsed = await parseNativeOauthJson(
    request,
    ctx.env.BETTER_AUTH_URL,
    nativeOauthExchangeSchema,
  );
  if (!parsed.ok) return parsed.response;

  const proof = {
    attemptId: parsed.data.attemptId,
    stateHash: await sha256Hex(parsed.data.state),
    pkceChallenge: await pkceChallenge(parsed.data.verifier),
    handoffCodeHash: await sha256Hex(parsed.data.code),
  };
  const db = getPrimaryDb(ctx.env.DB);
  let claimed;
  try {
    claimed = await queries.nativeOauth.claimExchange(db, proof);
  } catch {
    log.error("native OAuth exchange claim unavailable");
    return nativeOauthJson(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  if (!claimed) {
    return nativeOauthJson({ error: "invalid_handoff" }, { status: 400 });
  }

  let verifiedHeaders: Headers;
  try {
    const verified = await createAuth(ctx.env).api.verifyOneTimeToken({
      body: { token: parsed.data.code },
      returnHeaders: true,
    });
    verifiedHeaders = verified.headers;
  } catch {
    try {
      await queries.nativeOauth.failExchange(db, claimed.id);
    } catch {
      log.error("native OAuth exchange failure update unavailable");
    }
    log.warn("native OAuth handoff verification failed");
    return nativeOauthJson({ error: "invalid_handoff" }, { status: 400 });
  }

  let consumed;
  try {
    consumed = await queries.nativeOauth.finishExchange(db, proof);
  } catch {
    log.error("native OAuth exchange finalization unavailable");
    return nativeOauthJson(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  if (!consumed) {
    return nativeOauthJson({ error: "invalid_handoff" }, { status: 409 });
  }

  const responseHeaders = new Headers();
  copySetCookieHeaders(verifiedHeaders, responseHeaders);
  setWebViewAnalyticsCookie(
    responseHeaders,
    consumed.authKind === "signup" ? "signup" : "signin",
    consumed.provider,
    new URL(ctx.env.BETTER_AUTH_URL).protocol === "https:",
  );
  return nativeOauthJson(
    { redirectPath: consumed.redirectPath },
    { headers: responseHeaders },
  );
});
