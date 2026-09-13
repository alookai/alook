import { encrypt } from "@alook/shared/crypto";
import { queries } from "@alook/shared";
import { getPrimaryDb } from "@/lib/db";
import {
  hashProviderToken,
  notificationDeviceRegistrationSchema,
} from "@/lib/community/notification-device-schema";
import { withCookieHumanAuth } from "@/lib/middleware/auth";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";

export const POST = withCookieHumanAuth(async (req, ctx) => {
  const [body, error] = await parseBody(
    req,
    notificationDeviceRegistrationSchema,
  );
  if (error) return error;

  const encryptionKey = ctx.env.ENCRYPTION_KEY;
  if (!encryptionKey) return writeError("encryption not configured", 500);

  const [providerTokenHash, previousProviderTokenHash] = await Promise.all([
    hashProviderToken(body.providerToken),
    body.previousProviderToken
      ? hashProviderToken(body.previousProviderToken)
      : undefined,
  ]);
  const now = new Date().toISOString();

  const result = await queries.communityPushDevice.registerPushDevice(
    getPrimaryDb(ctx.env.DB),
    {
      userId: ctx.userId,
      installationId: body.installationId,
      platform: body.platform,
      providerEnvironment: body.providerEnvironment,
      providerTokenEncrypted: encrypt(body.providerToken, encryptionKey),
      providerTokenHash,
      previousProviderTokenHash,
      appVersion: body.appVersion,
      now,
    },
  );

  if (!result.ok) return writeError("device ownership conflict", 409);
  return writeJSON({ device: result.device });
});
