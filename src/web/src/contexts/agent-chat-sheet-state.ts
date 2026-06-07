export type AgentChatSheetMode = "main" | "branch";

export interface AgentChatSheetTarget {
  agentId: string;
  conversationId: string | null;
  taskId: string | null;
  messageId: string | null;
}

export interface AgentChatSheetOpenOptions {
  conversationId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
  mode?: AgentChatSheetMode;
  returnTo?: AgentChatSheetTarget | null;
}

export function normalizeSheetTarget(
  agentId: string,
  opts?: AgentChatSheetOpenOptions,
): AgentChatSheetTarget {
  return {
    agentId,
    conversationId: opts?.conversationId ?? null,
    taskId: opts?.taskId ?? null,
    messageId: opts?.messageId ?? null,
  };
}

export function capturePreviousMainTargetForBranch({
  isOpen,
  currentMode,
  currentTarget,
  explicitReturnTarget,
}: {
  isOpen: boolean;
  currentMode: AgentChatSheetMode;
  currentTarget: AgentChatSheetTarget | null;
  explicitReturnTarget?: AgentChatSheetTarget | null;
}): AgentChatSheetTarget | null {
  if (!isOpen || currentMode !== "main" || !currentTarget) return null;

  if (explicitReturnTarget) return explicitReturnTarget;

  if (
    !currentTarget.conversationId &&
    !currentTarget.taskId &&
    !currentTarget.messageId
  ) {
    return null;
  }

  return currentTarget;
}
