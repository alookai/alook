import { redirect } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { getTemplateById } from "@/lib/templates";
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
  const templateId = params.template;
  const initialTemplate = templateId ? getTemplateById(templateId) : undefined;

  const workspaceId = params.workspace_id ?? null;
  let workspaceName = "";
  let workspaceSlug = "";

  if (workspaceId) {
    const membership = await queries.member.getMemberByUserAndWorkspace(
      db,
      session.user.id,
      workspaceId,
    );
    if (!membership) redirect("/workspaces");

    const workspace = await queries.workspace.getWorkspace(db, workspaceId, session.user.id);
    if (!workspace) redirect("/workspaces");
    workspaceName = workspace.name;
    workspaceSlug = workspace.slug;
  }

  return (
    <StudioOnboardingClient
      workspaceId={workspaceId}
      workspaceSlug={workspaceSlug}
      workspaceName={workspaceName}
      initialTemplate={initialTemplate}
    />
  );
}
