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

const log = createLogger({ service: "native-oauth/status" });

export const POST = withEnv(async (request, ctx) => {
  const parsed = await parseNativeOauthJson(
    request,
    ctx.env.BETTER_AUTH_URL,
    nativeOauthProofSchema,
  );
  if (!parsed.ok) return parsed.response;

  let row;
  try {
    row = await queries.nativeOauth.getAttemptStatus(
      getPrimaryDb(ctx.env.DB),
      {
        attemptId: parsed.data.attemptId,
        stateHash: await sha256Hex(parsed.data.state),
        pkceChallenge: await pkceChallenge(parsed.data.verifier),
      },
    );
  } catch {
    log.error("native OAuth status unavailable");
    return nativeOauthJson(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
  if (!row) return nativeOauthJson({ status: "unknown" });

  const status =
    row.attemptExpiresAt <= Date.now() &&
    ["pending", "opened", "ready", "exchanging"].includes(row.status)
      ? "expired"
      : row.status;
  return nativeOauthJson({
    status,
    ...(status === "failed" && row.failureCode
      ? { failure: row.failureCode }
      : {}),
  });
});
