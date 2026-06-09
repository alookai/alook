import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries, RegistrationSourceSchema } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, parseBody } from "@/lib/middleware/helpers";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const [body, valErr] = await parseBody(req, RegistrationSourceSchema);
  if (valErr) return valErr;

  const hasAnyValue =
    body.utm_source || body.utm_medium || body.utm_campaign || body.referrer;
  if (!hasAnyValue) {
    return writeJSON({ updated: false });
  }

  const updated = await queries.user.updateRegistrationSource(db, ctx.userId, {
    utmSource: body.utm_source || null,
    utmMedium: body.utm_medium || null,
    utmCampaign: body.utm_campaign || null,
    referrer: body.referrer || null,
  });

  return writeJSON({ updated: !!updated });
});
