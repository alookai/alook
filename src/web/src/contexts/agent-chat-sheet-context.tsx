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
import {
  capturePreviousMainTargetForBranch,
  normalizeSheetTarget,
  type AgentChatSheetMode,
  type AgentChatSheetOpenOptions,
  type AgentChatSheetTarget,
} from "@/contexts/agent-chat-sheet-state";

interface AgentChatSheetContextValue {
  openAgentChat: (agentId: string, opts?: AgentChatSheetOpenOptions) => void;
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
  const [sheetMode, setSheetMode] = useState<AgentChatSheetMode>("main");
  const [previousMainTarget, setPreviousMainTarget] =
    useState<AgentChatSheetTarget | null>(null);

  const agent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;

  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; });

  const openAgentChat = useCallback(
    (id: string, opts?: AgentChatSheetOpenOptions) => {
      const found = agentsRef.current.find((a) => a.id === id);
      if (!found) {
        router.push(`/w/${slug}/agents/${id}`);
        return;
      }
      const nextMode = opts?.mode ?? "main";
      const currentTarget = agentId
        ? normalizeSheetTarget(agentId, {
            conversationId: targetConvId,
            taskId: scrollToTaskId,
            messageId: scrollToMessageId,
          })
        : null;
      const nextPreviousMainTarget =
        nextMode === "branch"
          ? capturePreviousMainTargetForBranch({
              isOpen: open,
              currentMode: sheetMode,
              currentTarget,
              explicitReturnTarget: opts?.returnTo,
            })
          : null;

      setAgentId(id);
      setTargetConvId(opts?.conversationId ?? null);
      setScrollToTaskId(opts?.taskId ?? null);
      setScrollToMessageId(opts?.messageId ?? null);
      setSheetMode(nextMode);
      setPreviousMainTarget(nextPreviousMainTarget);
      setOpen(true);
    },
    [
      agentId,
      open,
      router,
      scrollToMessageId,
      scrollToTaskId,
      sheetMode,
      slug,
      targetConvId,
    ],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setTargetConvId(null);
      setScrollToTaskId(null);
      setScrollToMessageId(null);
      setSheetMode("main");
      setPreviousMainTarget(null);
    }
  }, []);

  const handleReturnToPreviousMain = useCallback(() => {
    if (!previousMainTarget) return;

    setAgentId(previousMainTarget.agentId);
    setTargetConvId(previousMainTarget.conversationId);
    setScrollToTaskId(previousMainTarget.taskId);
    setScrollToMessageId(previousMainTarget.messageId);
    setSheetMode("main");
    setPreviousMainTarget(null);
    setOpen(true);
  }, [previousMainTarget]);

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
        mode={sheetMode}
        canReturnToPreviousMain={
          sheetMode === "branch" && previousMainTarget !== null
        }
        onReturnToPreviousMain={handleReturnToPreviousMain}
      />
    </AgentChatSheetContext.Provider>
  );
}
