"use client";

import { useRef, useCallback, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { assertWorkspaceOwner, captureWorkspaceOwner, runWorkspaceRequest, useWorkspaceOwner } from "@/contexts/workspace-context";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isAbortError } from "@/lib/errors";
import { runApplicationRequest } from "@/lib/application-owner";
import { AgentCreateForm } from "@/components/agent-create-form";
import { fetchModelOptions, createEmailAccount } from "@/lib/api";
import { toast } from "sonner";
import { CircleHelp } from "lucide-react";
import { trackAgentCreated, trackSecondAgentCreated, trackCustomEmailConnected } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";


type CreateAgentInput = Parameters<ComponentProps<typeof AgentCreateForm>["onSave"]>[0];
const EMPTY_MODELS: Record<string, string[]> = {};

export default function CreateAgentPage() {
  const router = useRouter();
  const workspace = useWorkspaceOwner();
  const { slug, workspaceId } = workspace;
  const {
    agents,
    runtimes,
    handleCreateAgent,
    getFirstOnlineRuntimeId,
  } = useAgentContext();

  const startTourRef = useRef<(() => void) | null>(null);
  const modelQuery = useQuery({
    queryKey: ["application", workspace.application.userId, "model-options"],
    queryFn: ({ signal }) => runApplicationRequest(workspace.application, (options) => fetchModelOptions(options), signal),
  });
  const modelOptions = modelQuery.data ?? EMPTY_MODELS;
  const create = useMutation({
    mutationKey: workspace.key("agents", "create-with-email"),
    mutationFn: async ({ data, token, agentCount }: { data: CreateAgentInput; token: ReturnType<typeof captureWorkspaceOwner>; agentCount: number }) => {
      assertWorkspaceOwner(token);
      const agent = await handleCreateAgent({
        name: data.name,
        description: data.description || undefined,
        instructions: data.instructions || undefined,
        runtime_id: data.runtime_id,
        email_handle: data.email_handle || undefined,
        runtime_config: data.runtime_config,
        avatar_url: data.avatar_url,
      });
      assertWorkspaceOwner(token);
      if (!agent) return false;
      trackAgentCreated({ is_first_agent: agentCount === 0, has_email: !!data.email_handle || !!data.custom_email });
      if (agentCount === 1) trackSecondAgentCreated({ total_agents: 2 });
      if (data.custom_email) {
        try {
          await runWorkspaceRequest(workspace, (options) => createEmailAccount(agent.id, data.custom_email!, workspaceId, options));
          assertWorkspaceOwner(token);
          toast.success("Custom email connected");
          trackCustomEmailConnected({ email_domain: data.custom_email.emailAddress?.split("@")[1] ?? "" });
        } catch (error) {
          assertWorkspaceOwner(token);
          if (isAbortError(error)) throw error;
          toast.error(error instanceof Error ? error.message : "Failed to connect custom email");
        }
      }
      assertWorkspaceOwner(token);
      router.push(`/w/${slug}/agents/${agent.id}/chat`);
      return true;
    },
  });

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
        saving={create.isPending}
        onCancel={() => router.back()}
        onSave={async (data) => {
          const token = captureWorkspaceOwner(workspace);
          try { return await create.mutateAsync({ data, token, agentCount: agents.length }); }
          catch (error) { if (isAbortError(error)) return false; throw error; }
        }}
      />
    </>
  );
}
