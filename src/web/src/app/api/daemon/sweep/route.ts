import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { SweepRequestSchema } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { sweepStaleState } from "@/lib/services/sweep";
import { promoteDueCalendarEventsForWorkspace } from "@/lib/services/calendar";
import { log } from "@/lib/logger";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext();
  const { throttled } = await import("@/lib/cache");

  const [, err] = await parseBody(req, SweepRequestSchema);
  if (err) return err;

  if (!ctx.workspaceId) {
    return writeError("Forbidden: machine token required", 403);
  }

  const db = getDb((env as Env).DB);

  try {
    await sweepStaleState(db, ctx.workspaceId);
  } catch (e) {
    log.warn("sweep failed", { workspaceId: ctx.workspaceId, err: String(e) });
  }

  try {
    await throttled(`cal:${ctx.workspaceId}`, 30, async () => {
      const enqueued = await promoteDueCalendarEventsForWorkspace(
        db,
        ctx.workspaceId!,
      );
      if (enqueued > 0) {
        log.info("calendar: enqueued", { workspaceId: ctx.workspaceId, enqueued });
      }
    });
  } catch (e) {
    log.warn("calendar: promote failed", { workspaceId: ctx.workspaceId, err: String(e) });
  }

  return writeJSON({ ok: true });
});
