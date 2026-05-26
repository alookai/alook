export interface ContextEnvVars {
  conversationId?: string;
  traceId?: string;
  sourceTaskId?: string;
}

export function gatherContextEnvVars(): ContextEnvVars {
  const conversationId = process.env.ALOOK_CONVERSATION_ID || undefined;
  const traceId = process.env.ALOOK_TRACE_ID || undefined;
  const sourceTaskId = process.env.ALOOK_TASK_ID || undefined;
  return { conversationId, traceId, sourceTaskId };
}
