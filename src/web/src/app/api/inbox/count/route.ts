import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { cached, cacheKeys } from "@/lib/cache";

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const db = getDb(ctx.env.DB);

  const VALID_TYPES = ["user_dm_message", "calendar_event", "email_notification"];
  const typesParam = req.nextUrl.searchParams.get("types");
  const types = typesParam
    ? typesParam.split(",").filter((t) => VALID_TYPES.includes(t))
    : [];
  const validTypes = types.length > 0 ? types : ["user_dm_message"];

  const count = await cached(cacheKeys.inboxCount(ctx.userId, ws.workspaceId, validTypes), 60, () =>
    queries.inbox.getUnreadCount(db, ctx.userId, ws.workspaceId, validTypes)
  );

  return writeJSON({ count });
});
