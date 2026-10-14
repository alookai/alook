import { createLogger, queries } from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import { withEnv } from "@/lib/middleware/env";
import {
  nativeOauthJson,
  nativeOauthProofSchema,
  parseNativeOauthJson,
  pkceChallenge,
  sha256Hex,
} from "@/lib/native-oauth";

const log = createLogger({ service: "native-oauth/cancel" });

export const POST = withEnv(async (request, ctx) => {
  const parsed = await parseNativeOauthJson(
    request,
    ctx.env.BETTER_AUTH_URL,
    nativeOauthProofSchema,
  );
  if (!parsed.ok) return parsed.response;

  let cancelled;
  try {
    cancelled = await queries.nativeOauth.cancelAttempt(
      getPrimaryDb(ctx.env.DB),
      {
        attemptId: parsed.data.attemptId,
        stateHash: await sha256Hex(parsed.data.state),
        pkceChallenge: await pkceChallenge(parsed.data.verifier),
      },
    );
  } catch {
    log.error("native OAuth cancellation unavailable");
    return nativeOauthJson(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  return nativeOauthJson({ status: cancelled ? "cancelled" : "unchanged" });
});
