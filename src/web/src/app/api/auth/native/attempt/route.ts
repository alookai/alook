import {
  createLogger,
  isUniqueConstraintError,
  queries,
} from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import { withEnv } from "@/lib/middleware/env";
import {
  nativeOauthJson,
  nativeOauthRegistrationSchema,
  nativeOauthStartUrl,
  parseNativeOauthJson,
  sha256Hex,
} from "@/lib/native-oauth";
import { checkRateLimit } from "@/lib/rate-limit";

const log = createLogger({ service: "native-oauth/attempt" });

export const POST = withEnv(async (request, ctx) => {
  const parsed = await parseNativeOauthJson(
    request,
    ctx.env.BETTER_AUTH_URL,
    nativeOauthRegistrationSchema,
  );
  if (!parsed.ok) return parsed.response;

  const clientKey = await sha256Hex(
    request.headers.get("CF-Connecting-IP") ?? "unknown",
  );
  const rate = await checkRateLimit(ctx.env, "auth:nativeAttempt", clientKey);
  if (!rate.allowed) {
    const headers = new Headers();
    if (rate.retryAfterSec !== undefined) {
      headers.set("Retry-After", String(rate.retryAfterSec));
    }
    return nativeOauthJson({ error: "rate_limited" }, { status: 429, headers });
  }

  try {
    await queries.nativeOauth.registerAttempt(getPrimaryDb(ctx.env.DB), {
      id: parsed.data.attemptId,
      instanceKeyHash: parsed.data.instanceKeyHash,
      stateHash: parsed.data.stateHash,
      pkceChallenge: parsed.data.codeChallenge,
      provider: parsed.data.provider,
      platform: parsed.data.platform,
      redirectPath: parsed.data.redirectPath,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      log.warn("native OAuth attempt registration conflict");
      return nativeOauthJson({ error: "attempt_conflict" }, { status: 409 });
    }
    log.error("native OAuth attempt registration failed");
    return nativeOauthJson(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }

  return nativeOauthJson({
    startUrl: nativeOauthStartUrl(
      ctx.env.BETTER_AUTH_URL,
      parsed.data.attemptId,
    ),
  });
});
