/**
 * Agent instruction file — writes system prompt as AGENTS.md + symlinks CLAUDE.md.
 *
 * Claude Code auto-reads CLAUDE.md from cwd, so by writing the system prompt into
 * the workdir as a file (instead of passing it via a CLI flag), the agent picks it
 * up natively. The canonical source is AGENTS.md; CLAUDE.md is a symlink to it.
 * This avoids shell escaping issues with long prompts and lets the agent see its
 * own instructions via the filesystem.
 */
import {
  writeFileSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  existsSync,
  readlinkSync,
  copyFileSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";

export const CANONICAL_FILE = "AGENTS.md";
export const SYMLINK_ALIASES = ["CLAUDE.md"];

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function hasContentChanged(filePath: string, newContent: string): boolean {
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
        if (target === CANONICAL_FILE) continue;
        unlinkSync(aliasPath);
      } else {
        const aliasContent = readFileSync(aliasPath, "utf-8");
        const canonicalContent = readFileSync(canonicalPath, "utf-8");
        if (aliasContent === canonicalContent) continue;
        unlinkSync(aliasPath);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }

    try {
      symlinkSync(CANONICAL_FILE, aliasPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") {
        // Race between concurrent launches for same agent — first writer wins.
      } else if (code === "EPERM" || code === "EACCES") {
        copyFileSync(canonicalPath, aliasPath);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Write system prompt to AGENTS.md in the agent's workdir and ensure CLAUDE.md
 * symlinks to it. Only writes if content has changed (avoids unnecessary fs churn).
 * Returns true if the file was actually written.
 */
export function writeAgentFile(workDir: string, systemPromptContent: string): boolean {
  const filePath = join(workDir, CANONICAL_FILE);
  const changed = hasContentChanged(filePath, systemPromptContent);
  if (changed) {
    writeFileSync(filePath, systemPromptContent, "utf-8");
  }
  ensureSymlinks(workDir);
  return changed;
}
