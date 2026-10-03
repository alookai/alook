"use client";

import { useMemo, type ReactNode } from "react";
import { createStore, createStoreContext, useSelector } from "@tanstack/react-store";
import { useRouter } from "next/navigation";
import type { Agent } from "@alook/shared";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspaceOwner } from "@/contexts/workspace-context";
import { AgentChatSheet } from "@/components/canvas/agent-chat-sheet";

type ChatTarget = { conversationId?: string; taskId?: string; messageId?: string };
function createSheetStore() {
  return createStore({ open: false, agentId: null as string | null, targetConvId: null as string | null, scrollToTaskId: null as string | null, scrollToMessageId: null as string | null });
}
const { StoreProvider, useStoreContext } = createStoreContext<{
  ui: ReturnType<typeof createSheetStore>;
  openAgentChat: (agentId: string, options?: ChatTarget) => void;
}>();
export function useAgentChatSheet() {
  const { openAgentChat } = useStoreContext();
  return useMemo(() => ({ openAgentChat }), [openAgentChat]);
}
export function AgentChatSheetProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const workspace = useWorkspaceOwner();
  const { agents } = useAgentContext();
  const handles = useMemo(() => {
    const ui = createSheetStore();
    return {
      ui,
      openAgentChat: (agentId: string, options?: ChatTarget) => {
        if (!workspace.lifecycle.get().active || !workspace.application.lifecycle.get().active) return;
        const found = workspace.queryClient.getQueryData<Agent[]>(workspace.key("agents"))?.some((agent) => agent.id === agentId);
        if (!found) { router.push(`/w/${workspace.slug}/agents/${agentId}`); return; }
        ui.setState(() => ({ open: true, agentId, targetConvId: options?.conversationId ?? null, scrollToTaskId: options?.taskId ?? null, scrollToMessageId: options?.messageId ?? null }));
      },
    };
  }, [workspace, router]);
  const state = useSelector(handles.ui, (value) => value);
  const agent = agents.find((value) => value.id === state.agentId) ?? null;
  return <StoreProvider value={handles}>
    {children}
    <AgentChatSheet
      {...state}
      onOpenChange={(open) => {
        if (!workspace.lifecycle.get().active || !workspace.application.lifecycle.get().active) return;
        handles.ui.setState((previous) => ({ ...previous, open, ...(open ? {} : { targetConvId: null, scrollToTaskId: null, scrollToMessageId: null }) }));
      }}
      agent={agent}
    />
  </StoreProvider>;
}
