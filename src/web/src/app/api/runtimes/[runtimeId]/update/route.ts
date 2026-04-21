import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { writeJSON, writeError } from "@/lib/middleware/helpers";

async function fetchLatestCliVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/@alook/cli/latest");
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const runtimeId = req.nextUrl.pathname.split("/runtimes/")[1]?.split("/")[0];
  if (!runtimeId) return writeError("runtime id required", 400);

  const runtime = await queries.runtime.getAgentRuntimeForWorkspace(
    db,
    runtimeId,
    ws.workspaceId,
  );
  if (!runtime) return writeError("runtime not found", 404);

  const latestVersion = await fetchLatestCliVersion();
  if (!latestVersion) return writeError("failed to fetch latest CLI version from npm", 502);

  await queries.machine.setPendingUpdateVersion(db, runtime.daemonId, latestVersion);

  return writeJSON({ pending_update_version: latestVersion });
});

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const runtimeId = req.nextUrl.pathname.split("/runtimes/")[1]?.split("/")[0];
  if (!runtimeId) return writeError("runtime id required", 400);

  const runtime = await queries.runtime.getAgentRuntimeForWorkspace(
    db,
    runtimeId,
    ws.workspaceId,
  );
  if (!runtime) return writeError("runtime not found", 404);

  await queries.machine.clearPendingUpdateVersion(db, runtime.daemonId);

  return new Response(null, { status: 204 });
});
