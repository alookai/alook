"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { AgentEditForm } from "@/components/agent-edit-form";
import { fetchModelOptions, createEmailAccount } from "@/lib/api";
import { toast } from "sonner";
import { MobileSidebarLogo } from "@/components/mobile-sidebar-logo";

export default function CreateAgentPage() {
  const router = useRouter();
  const { slug, workspaceId } = useWorkspace();
  const {
    runtimes,
    handleCreateAgent,
    getFirstOnlineRuntimeId,
  } = useAgentContext();

  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetchModelOptions().then(setModelOptions).catch(() => {});
  }, []);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/50 px-3 md:px-5 py-2.5">
        <MobileSidebarLogo />
        <h1 className="text-sm font-medium">Create Agent</h1>
      </div>

      <AgentEditForm
        runtimes={runtimes}
        defaultRuntimeId={getFirstOnlineRuntimeId()}
        modelOptions={modelOptions}
        saving={saving}
        submitLabel="Create"
        savingLabel="Creating..."
        onCancel={() => router.back()}
        onSave={async (data) => {
          setSaving(true);
          try {
            const agent = await handleCreateAgent({
              name: data.name,
              description: data.description || undefined,
              instructions: data.instructions || undefined,
              runtime_id: data.runtime_id,
              email_handle: data.email_handle || undefined,
              runtime_config: data.runtime_config,
            });
            if (agent) {
              if (data.custom_email) {
                try {
                  await createEmailAccount(agent.id, data.custom_email, workspaceId);
                  toast.success("Custom email connected");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to connect custom email");
                }
              }
              router.push(`/w/${slug}/agents/${agent.id}/chat`);
            }
            return !!agent;
          } finally {
            setSaving(false);
          }
        }}
      />
    </>
  );
}
