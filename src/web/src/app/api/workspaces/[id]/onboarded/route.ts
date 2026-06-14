import { NextRequest } from "next/server";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON } from "@/lib/middleware/helpers";

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB);

  const id = req.nextUrl.pathname.split("/").at(-2)!;

  const membership = await queries.member.getMemberByUserAndWorkspace(db, ctx.userId, id);
  if (!membership) {
    return writeJSON({ error: "not a member" }, 403);
  }

  await queries.workspace.markOnboarded(db, id);
  return writeJSON({ ok: true });
});
