import { mkdirSync } from "fs";
import { join } from "path";
import { writeInstructionFileIfChanged } from "./context.js";
import type { Task } from "../types.js";

export interface ExecEnvConfig {
  workspacesRoot: string;
}

export interface ExecEnvResult {
  workDir: string;
  timelineDir: string;
  env: Record<string, string>;
}

export function prepare(
  config: ExecEnvConfig,
  task: Task,
): ExecEnvResult {
  const workDir = join(config.workspacesRoot, task.workspaceId, task.agentId, "workdir");

  mkdirSync(workDir, { recursive: true });

  const timelineDir = join(workDir, ".context_timeline");
  mkdirSync(timelineDir, { recursive: true });

  writeInstructionFileIfChanged(workDir, task);

  const env: Record<string, string> = {
    ALOOK_WORKSPACE_ID: task.workspaceId,
    ALOOK_AGENT_ID: task.agentId,
    ALOOK_TASK_ID: task.id,
    ALOOK_CONVERSATION_ID: task.conversationId,
    ALOOK_HEALTH_PORT: process.env.ALOOK_HEALTH_PORT || "19514",
  };

  return { workDir, timelineDir, env };
}

export { buildInstructionContent, writeInstructionFileIfChanged, ensureSymlinks, CANONICAL_FILE } from "./context.js";
