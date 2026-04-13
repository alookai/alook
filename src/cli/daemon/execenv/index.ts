import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { writeInstructionFile, cleanStaleProviderFiles } from "./context.js";
import type { Task } from "../types.js";

export interface ExecEnvConfig {
  workspacesRoot: string;
}

export interface ExecEnvResult {
  workDir: string;
  logFile: string;
  env: Record<string, string>;
}

export function prepare(
  config: ExecEnvConfig,
  task: Task,
  provider: string,
): ExecEnvResult {
  const workDir = join(config.workspacesRoot, task.workspaceId, task.agentId, "workdir");

  mkdirSync(workDir, { recursive: true });

  writeInstructionFile(workDir, task, provider);
  cleanStaleProviderFiles(workDir, provider);

  const logFile = join(
    config.workspacesRoot,
    task.workspaceId,
    task.agentId,
    "agent.log",
  );
  mkdirSync(dirname(logFile), { recursive: true });

  const env: Record<string, string> = {
    ALOOK_WORKSPACE_ID: task.workspaceId,
    ALOOK_AGENT_ID: task.agentId,
    ALOOK_TASK_ID: task.id,
    ALOOK_CONVERSATION_ID: task.conversationId,
    ALOOK_HEALTH_PORT: process.env.ALOOK_HEALTH_PORT || "19514",
  };

  return { workDir, logFile, env };
}

export { buildInstructionContent, writeInstructionFile, cleanStaleProviderFiles } from "./context.js";
