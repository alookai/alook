"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useAgentContext } from "@/contexts/agent-context";
import { useWorkspace } from "@/contexts/workspace-context";
import { AgentChatSheet } from "@/components/canvas/agent-chat-sheet";

interface AgentChatSheetContextValue {
  openAgentChat: (
    agentId: string,
    opts?: { conversationId?: string; taskId?: string; messageId?: string },
  ) => void;
}

const AgentChatSheetContext = createContext<AgentChatSheetContextValue | null>(
  null,
);

export function useAgentChatSheet() {
  const ctx = useContext(AgentChatSheetContext);
  if (!ctx)
    throw new Error(
      "useAgentChatSheet must be used within AgentChatSheetProvider",
    );
  return ctx;
}

export function AgentChatSheetProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { agents } = useAgentContext();
  const { slug } = useWorkspace();

  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [targetConvId, setTargetConvId] = useState<string | null>(null);
  const [scrollToTaskId, setScrollToTaskId] = useState<string | null>(null);
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);

  const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;

  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; });

  const openAgentChat = useCallback(
    (id: string, opts?: { conversationId?: string; taskId?: string; messageId?: string }) => {
      const found = agentsRef.current.find((a) => a.id === id);
      if (!found) {
        router.push(`/w/${slug}/agents/${id}`);
        return;
      }
      setAgentId(id);
      setTargetConvId(opts?.conversationId ?? null);
      setScrollToTaskId(opts?.taskId ?? null);
      setScrollToMessageId(opts?.messageId ?? null);
      setOpen(true);
    },
    [router, slug],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setTargetConvId(null);
      setScrollToTaskId(null);
      setScrollToMessageId(null);
    }
  }, []);

  return (
    <AgentChatSheetContext.Provider value={{ openAgentChat }}>
      {children}
      <AgentChatSheet
        open={open}
        onOpenChange={handleOpenChange}
        agentId={agentId}
        agent={agent}
        targetConvId={targetConvId}
        scrollToTaskId={scrollToTaskId}
        scrollToMessageId={scrollToMessageId}
      />
    </AgentChatSheetContext.Provider>
  );
}
