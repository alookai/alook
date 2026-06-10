import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries, isUniqueConstraintError, generateWorkspaceSlug, CreateWorkspaceRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { nanoid } from "nanoid"
import { withAuth } from "@/lib/middleware/auth";
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers";
import { workspaceToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (_req, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const workspaces = await queries.workspace.listWorkspaces(db, ctx.userId);
  return writeJSON(workspaces.map(workspaceToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const [body, valErr] = await parseBody(req, CreateWorkspaceRequestSchema);
  if (valErr) return valErr;

  const name = body.name.trim();
  const slug = body.slug?.trim() ? body.slug.toLowerCase().trim() : generateWorkspaceSlug();

  const suffixLengths = [4, 4, 4, 8, 8, 8, 16, 16, 16];
  let candidateSlug = slug;

  for (let attempt = 0; ; attempt++) {
    try {
      const ws = await queries.workspace.createWorkspace(db, { name, slug: candidateSlug });
      await queries.member.createMember(db, {
        workspaceId: ws.id,
        userId: ctx.userId,
        role: "owner",
      });
      return writeJSON(workspaceToResponse(ws), 201);
    } catch (err: unknown) {
      if (!isUniqueConstraintError(err)) throw err;
      if (attempt >= suffixLengths.length) {
        return writeError("workspace slug already exists", 409);
      }
      candidateSlug = `${slug}-${nanoid(suffixLengths[attempt])}`;
    }
  }
});
