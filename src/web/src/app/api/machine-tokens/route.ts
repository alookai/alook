import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { generateMachineToken } from "@/lib/token";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON } from "@/lib/middleware/helpers";
import { machineTokenToResponse } from "@/lib/api/responses";

export const GET = withAuth(async (req, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const tokens = await queries.machineToken.listMachineTokens(db, ctx.userId, ws.workspaceId);
  return writeJSON(tokens.map(machineTokenToResponse));
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const { env } = getCloudflareContext()
  const db = getDb((env as Env).DB)

  const wsParam = req.nextUrl.searchParams.get("workspace_id");
  let workspaceId: string | null = null;

  if (wsParam) {
    const ws = await withWorkspaceMember(req, ctx);
    if (ws instanceof Response) return ws;
    workspaceId = ws.workspaceId;
  }

  const pending = await queries.machineToken.getPendingMachineToken(db, ctx.userId, workspaceId);
  if (pending) {
    return writeJSON({ token: pending.token, ...machineTokenToResponse(pending) });
  }

  const registered = await queries.machineToken.getRegisteredTokenForUser(db, ctx.userId);
  if (registered) {
    return writeJSON({ token: registered.token, ...machineTokenToResponse(registered) });
  }

  let name = "default";
  try {
    const body = (await req.json()) as { name?: string };
    if (body.name && typeof body.name === "string" && body.name.trim()) {
      name = body.name.trim();
    }
  } catch {
    // body parse error → use default name
  }

  const raw = generateMachineToken();

  const mt = await queries.machineToken.createMachineToken(db, {
    userId: ctx.userId,
    workspaceId,
    token: raw,
    name,
    status: "pending",
  });

  return writeJSON({ token: raw, ...machineTokenToResponse(mt) }, 201);
});
