import type { Database } from "@alook/shared";
import { TASK_TYPES } from "@alook/shared";
import { applyEmailTriageResult, parseEmailTriageOutput } from "@/lib/services/email-triage";
import { log } from "@/lib/logger";

type TerminalTask = {
  id: string;
  agentId: string;
  workspaceId: string;
  conversationId: string;
  type?: string | null;
  context?: unknown;
};

export async function handleTaskTerminalSideEffects(input: {
  db: Database;
  workspaceId: string;
  task: TerminalTask;
  terminalState: "completed" | "failed";
  parsedResult: unknown;
}): Promise<{ handled: false } | { handled: true; error?: string }> {
  if (input.task.type !== TASK_TYPES.EMAIL_TRIAGE) {
    return { handled: false };
  }

  if (input.terminalState === "failed") {
    return { handled: true };
  }

  const payload = input.parsedResult as Record<string, unknown>;
  const rawOutput = typeof payload?.output === "string" ? payload.output : "";
  const parsed = parseEmailTriageOutput(rawOutput);
  if (!parsed.ok) {
    return { handled: true, error: "invalid email triage output" };
  }

  const taskContext = input.task.context as Record<string, unknown> | null | undefined;
  const inboundEmailId = typeof taskContext?.inboundEmailId === "string"
    ? taskContext.inboundEmailId
    : "";
  if (!inboundEmailId) {
    return { handled: true, error: "email triage missing inboundEmailId" };
  }

  const result = await applyEmailTriageResult(
    input.db,
    input.workspaceId,
    input.task.agentId,
    inboundEmailId,
    parsed,
  );
  if (!result.applied && result.cleanupError) {
    log.warn("email triage cleanup failed", {
      taskId: input.task.id,
      inboundEmailId,
      cleanupError: result.cleanupError,
    });
    return { handled: true, error: `email triage apply failed: ${result.cleanupError}` };
  }
  if (!result.applied) {
    return { handled: true, error: "email triage apply failed" };
  }

  return { handled: true };
}
