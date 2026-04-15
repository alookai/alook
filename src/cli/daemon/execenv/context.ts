import { createHash } from "crypto";
import {
  writeFileSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  existsSync,
  readlinkSync,
} from "fs";
import { join } from "path";
import type { Task } from "../types.js";

export const CANONICAL_FILE = "AGENTS.md";
export const SYMLINK_ALIASES = ["CLAUDE.md"];

const SYSTEM_PROMPT = `## Memory Management
- Your memory directory is ./, don't write ANY EXTERNAL memory file.
- Write ESSENTIAL yet SHORT memory to ./memory.md
- For SPECIFIC yet LONG rules or pattern, write to experiences/[NAME].md, and add index to ./memory.md for later recall.
### whats is ESSENTIAL and SHORT Memory?
- basic user profile, e.g.:
  - "user name is gus"
  - "user is working on alook"
- certain local project mapping, e.g.:
  - "alook means the project under /user/home/alook/"
- when to read certain stuff, e.g.:
  - "read ./experiences/alook_dev_workflow.md when start a new pr in alook"
Essential means you think you generally need to read it every time, short means a short sentence can describe this memory
### whats is SPECIFIC and LONG Memory?
- specific workflow that trigger at certain cases, e.g.:
  - user ask your to summarize the before workflow with certain skills usage as the common workflow when write a new slide about agent. Write it to experiences/slide-for-agent.md.
SPECIFIC means you think you just need to use it conditionally, long means you need to detailed, more than 140 chars text to describe it.

## Context Timeline
You're a working branch of a powerful personal agent in Alook platform. 
Your current context is only a fraction of the full picture.
The full picture is inside \`./.context_timeline/YYYY-MM-DD.jsonl\`
Each line of a timeline JSONL is a JSON object with these fields:
- "task_id" — unique task identifier
- "session_id" — agent session identifier (null until completion)
- "pid" — daemon process ID (present while running, null when done)
- "status" — "running", "completed", or "failed"
- "datetime" — when the task started (local timezone)
- "type" — always "user_dm_message"
- "prompt" — what the user asked
- "agent_responses" — assistant text outputs during execution
- "errmsg" — error message (null unless status is "failed")
those json are sorted by datetime in asc order.

## RULES
- Read @memory.md(if exists) before your action.
- When you start a new task, read the last ~10 lines of today's timeline to understand what has been asked and done recently.
  - if you don't know the current datetime, obtain the current datetime first.
- When user ask you something you don't have in your current context, try to read the timeline jsonl files for answer (today or previous days).
`;

export function buildInstructionContent(task: Task): string {
  let content = SYSTEM_PROMPT;

  if (task.agent?.instructions) {
    content += `\n\n## Agent Instructions\n${task.agent.instructions}`;
  }

  return content;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function hasContentChanged(
  filePath: string,
  newContent: string,
): boolean {
  try {
    const existing = readFileSync(filePath, "utf-8");
    return contentHash(existing) !== contentHash(newContent);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw err;
  }
}

export function ensureSymlinks(workDir: string): void {
  const canonicalPath = join(workDir, CANONICAL_FILE);
  if (!existsSync(canonicalPath)) return;

  for (const alias of SYMLINK_ALIASES) {
    if (alias === CANONICAL_FILE) continue;

    const aliasPath = join(workDir, alias);

    try {
      const stat = lstatSync(aliasPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(aliasPath);
        if (target === CANONICAL_FILE) continue; // already correct
        unlinkSync(aliasPath);
      } else {
        // regular file — remove it
        unlinkSync(aliasPath);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      // doesn't exist — will create below
    }

    symlinkSync(CANONICAL_FILE, aliasPath);
  }
}

export function writeInstructionFileIfChanged(
  workDir: string,
  task: Task,
): boolean {
  const content = buildInstructionContent(task);
  const filePath = join(workDir, CANONICAL_FILE);

  const changed = hasContentChanged(filePath, content);
  if (changed) {
    writeFileSync(filePath, content, "utf-8");
  }

  ensureSymlinks(workDir);
  return changed;
}
