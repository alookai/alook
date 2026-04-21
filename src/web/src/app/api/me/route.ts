import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError } from "@/lib/middleware/helpers";
import { userToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (_req, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const user = await queries.user.getUser(db, ctx.userId);
  if (!user) {
    return writeError("user not found", 404);
  }
  return writeJSON(userToResponse(user));
});
