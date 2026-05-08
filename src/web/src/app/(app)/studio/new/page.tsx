import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { StudioOnboardingClient } from "./client";

export default async function StudioNewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession();
  const { env } = await getCloudflareContext({ async: true });
  const db = getDb((env as Env).DB);

  const params = await searchParams;
  let workspaceId = params.workspace_id;

  if (!workspaceId) {
    const workspaces = await queries.workspace.listWorkspaces(db, session.user.id);
    if (workspaces.length === 0) redirect("/workspaces");
    workspaceId = workspaces[workspaces.length - 1].id;
  }

  const membership = await queries.member.getMemberByUserAndWorkspace(
    db,
    session.user.id,
    workspaceId,
  );
  if (!membership) redirect("/workspaces");

  const workspace = await queries.workspace.getWorkspace(db, workspaceId, session.user.id);
  if (!workspace) redirect("/workspaces");

  return (
    <StudioOnboardingClient
      workspaceId={workspaceId}
      workspaceSlug={workspace.slug}
      workspaceName={workspace.name}
    />
  );
}
