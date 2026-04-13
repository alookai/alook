import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { Task } from "../types.js";

const INSTRUCTION_FILES = {
  claude: "CLAUDE.md",
  opencode: "AGENTS.md",
  codex: "AGENTS.md",
} as const;

export function buildInstructionContent(task: Task): string {
  let content = `# Alook Agent Instructions

## System
SYSPROMPT TODO FOR ALOOK`;

  if (task.agent?.instructions) {
    content += `

## Agent Instructions
${task.agent.instructions}`;
  }

  return content;
}

export function writeInstructionFile(
  workDir: string,
  task: Task,
  provider: string,
): void {
  const fileName = INSTRUCTION_FILES[provider as keyof typeof INSTRUCTION_FILES];
  if (!fileName) return;

  const content = buildInstructionContent(task);
  writeFileSync(join(workDir, fileName), content, "utf-8");
}

export function cleanStaleProviderFiles(
  workDir: string,
  provider: string,
): void {
  if (!(provider in INSTRUCTION_FILES)) return;

  try {
    if (provider === "claude") {
      unlinkSync(join(workDir, "AGENTS.md"));
    } else {
      unlinkSync(join(workDir, "CLAUDE.md"));
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
