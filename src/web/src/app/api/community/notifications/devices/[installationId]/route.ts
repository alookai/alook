import { queries } from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import {
  isCookieHumanSameOrigin,
  notificationDeviceInstallationIdSchema,
} from "@/lib/community/notification-device-schema";
import { withCommunityActor } from "@/lib/middleware/community-actor";
import { writeError } from "@/lib/middleware/helpers";

export const DELETE = withCommunityActor(async (req, ctx) => {
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

  await queries.communityPushDevice.disablePushDevice(
    getPrimaryDb(ctx.env.DB),
    {
      userId: ctx.actor.userId,
      installationId: parsedInstallationId.data,
      now: new Date().toISOString(),
    },
  );

  return new Response(null, { status: 204 });
});
