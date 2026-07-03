"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { AgentCreateForm } from "@/components/agent-create-form";
import { fetchModelOptions, createEmailAccount } from "@/lib/api";
import { toast } from "sonner";
import { CircleHelp } from "lucide-react";
import { trackAgentCreated, trackSecondAgentCreated, trackCustomEmailConnected } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";


export default function CreateAgentPage() {
  const router = useRouter();
  const { slug, workspaceId } = useWorkspace();
  const {
    agents,
    runtimes,
    handleCreateAgent,
    getFirstOnlineRuntimeId,
  } = useAgentContext();

  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const startTourRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    fetchModelOptions().then(setModelOptions).catch(() => {});
  }, []);

  const handleTourReady = useCallback((startTour: () => void) => {
    startTourRef.current = startTour;
  }, []);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/50 px-3 sm:px-4 py-2">
        <h1 className="text-sm font-medium">Create Agent</h1>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => startTourRef.current?.()}
                className="text-muted-foreground"
              />
            }
          >
            <CircleHelp className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>Show guided tour</TooltipContent>
        </Tooltip>
      </div>

      <AgentCreateForm
        runtimes={runtimes}
        defaultRuntimeId={getFirstOnlineRuntimeId()}
        modelOptions={modelOptions}
        guided={agents.length === 0}
        onTourReady={handleTourReady}
        saving={saving}
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
              avatar_url: data.avatar_url,
            });
            if (agent) {
              trackAgentCreated({
                is_first_agent: agents.length === 0,
                has_email: !!data.email_handle || !!data.custom_email,
              });
              if (agents.length === 1) {
                trackSecondAgentCreated({ total_agents: 2 });
              }
              if (data.custom_email) {
                try {
                  await createEmailAccount(agent.id, data.custom_email, workspaceId);
                  toast.success("Custom email connected");
                  const domain = data.custom_email.emailAddress?.split("@")[1] ?? "";
                  trackCustomEmailConnected({ email_domain: domain });
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
