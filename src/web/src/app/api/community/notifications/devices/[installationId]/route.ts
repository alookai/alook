import { isCookieHumanSameOrigin } from "@/lib/server/request-security";
import { withAuth } from "@/lib/middleware/auth-policy"
import { queries } from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import {
  hashProviderToken,
  notificationDeviceInstallationIdSchema,
  notificationDeviceUnregistrationSchema,
} from "@/lib/community/notification-device-schema";
import { communityActorPolicy } from "@/lib/middleware/community-actor";
import { writeError } from "@/lib/middleware/helpers";

export const DELETE = withAuth(communityActorPolicy(), async (req, ctx) => {
  if (req.headers.has("Authorization")) return writeError("unauthorized", 401);
  if (ctx.actor.kind !== "human") return writeError("forbidden", 403);
  if (!isCookieHumanSameOrigin(req)) return writeError("forbidden", 403);

  const rawInstallationId = ctx.params?.installationId;
  if (!rawInstallationId) return writeError("installation id is required", 400);

  let installationId: string;
  try {
    installationId = decodeURIComponent(rawInstallationId);
  } catch {
    return writeError("invalid installation id", 400);
  }

  const parsedInstallationId =
    notificationDeviceInstallationIdSchema.safeParse(installationId);
  if (!parsedInstallationId.success) {
    return writeError("invalid installation id", 400);
  }

  let providerTokenHash: string | undefined;
  let previousProviderTokenHash: string | undefined;
  const rawBody = await req.text();
  if (rawBody.trim().length > 0) {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return writeError("invalid json", 400);
    }
    const parsedBody = notificationDeviceUnregistrationSchema.safeParse(json);
    if (!parsedBody.success) {
      return writeError("invalid request body", 400);
    }
    [providerTokenHash, previousProviderTokenHash] = await Promise.all([
      parsedBody.data.providerToken
        ? hashProviderToken(parsedBody.data.providerToken)
        : undefined,
      parsedBody.data.previousProviderToken
        ? hashProviderToken(parsedBody.data.previousProviderToken)
        : undefined,
    ]);
  }

  await queries.communityPushDevice.disablePushDevice(
    getPrimaryDb(ctx.env.DB),
    {
      userId: ctx.actor.userId,
      installationId: parsedInstallationId.data,
      ...(providerTokenHash ? { providerTokenHash } : {}),
      ...(previousProviderTokenHash ? { previousProviderTokenHash } : {}),
      now: new Date().toISOString(),
    },
  );

  return new Response(null, { status: 204 });
});
