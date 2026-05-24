import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { createLogger } from "../lib/logger.js";
import { configDir } from "../lib/config.js";
import type { DaemonClient } from "./client.js";

const log = createLogger({ module: "skill-scanner" });

export interface SkillEntry {
  name: string;
  description: string;
  scope: "global" | "agent";
}

function getCacheDir(): string {
  return join(configDir(), "skills");
}

function ensureCacheDir() {
  const dir = getCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function parseFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*(.+)$/m);

  if (!nameMatch) return null;

  return {
    name: nameMatch[1].trim().replace(/^["']|["']$/g, ""),
    description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "",
  };
}

function safeReadDir(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function findSkillFiles(baseDir: string, pattern: string): string[] {
  const results: string[] = [];
  if (!existsSync(baseDir)) return results;

  if (pattern === "*/SKILL.md") {
    for (const entry of safeReadDir(baseDir)) {
      const skillPath = join(baseDir, entry, "SKILL.md");
      try {
        if (existsSync(skillPath) && statSync(skillPath).isFile()) {
          results.push(skillPath);
        }
      } catch { /* skip */ }
    }
  } else if (pattern === "**/skills/*/SKILL.md") {
    walkForSkills(baseDir, results);
  } else if (pattern === "*.md") {
    for (const entry of safeReadDir(baseDir)) {
      if (entry.endsWith(".md")) {
        const filePath = join(baseDir, entry);
        try {
          if (statSync(filePath).isFile()) {
            results.push(filePath);
          }
        } catch { /* skip */ }
      }
    }
  }

  return results;
}

function walkForSkills(dir: string, results: string[], depth = 0): void {
  if (depth > 5) return;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === "skills") {
            for (const skillDir of safeReadDir(full)) {
              const skillPath = join(full, skillDir, "SKILL.md");
              try {
                if (existsSync(skillPath) && statSync(skillPath).isFile()) {
                  results.push(skillPath);
                }
              } catch { /* skip */ }
            }
          } else {
            walkForSkills(full, results, depth + 1);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function scanFrontmatterSkills(paths: string[], scope: "global" | "agent"): SkillEntry[] {
  const skills = new Map<string, SkillEntry>();
  for (const filePath of paths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !skills.has(meta.name)) {
        skills.set(meta.name, { ...meta, scope });
      }
    } catch { /* skip */ }
  }
  return Array.from(skills.values());
}

export function scanClaudeSkills(workdir?: string): SkillEntry[] {
  const home = homedir();
  const allSkills: SkillEntry[] = [];

  // Global skills
  const directPaths = findSkillFiles(join(home, ".claude", "skills"), "*/SKILL.md");
  allSkills.push(...scanFrontmatterSkills(directPaths, "global"));

  const pluginCacheDir = join(home, ".claude", "plugins", "cache");
  const pluginPaths = findSkillFiles(pluginCacheDir, "**/skills/*/SKILL.md");
  const globalNames = new Set(allSkills.map((s) => s.name));
  for (const filePath of pluginPaths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !globalNames.has(meta.name)) {
        globalNames.add(meta.name);
        allSkills.push({ ...meta, scope: "global" });
      }
    } catch { /* skip */ }
  }

  // Project skills
  if (workdir) {
    const projectPaths = findSkillFiles(join(workdir, ".claude", "skills"), "*/SKILL.md");
    allSkills.push(...scanFrontmatterSkills(projectPaths, "agent"));
  }

  return allSkills;
}

export function scanCodexSkills(workdir?: string): SkillEntry[] {
  const home = homedir();
  const allSkills: SkillEntry[] = [];

  const paths = [
    ...findSkillFiles(join(home, ".agents", "skills"), "*/SKILL.md"),
    ...findSkillFiles(join(home, ".codex", "skills", ".system"), "*/SKILL.md"),
  ];
  allSkills.push(...scanFrontmatterSkills(paths, "global"));

  const codexPluginDir = join(home, ".codex", "plugins", "cache");
  const pluginPaths = findSkillFiles(codexPluginDir, "**/skills/*/SKILL.md");
  const globalNames = new Set(allSkills.map((s) => s.name));
  for (const filePath of pluginPaths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !globalNames.has(meta.name)) {
        globalNames.add(meta.name);
        allSkills.push({ ...meta, scope: "global" });
      }
    } catch { /* skip */ }
  }

  // Project skills
  if (workdir) {
    const projectPaths = findSkillFiles(join(workdir, ".agents", "skills"), "*/SKILL.md");
    allSkills.push(...scanFrontmatterSkills(projectPaths, "agent"));
  }

  return allSkills;
}

export function scanOpenCodeSkills(workdir?: string): SkillEntry[] {
  const home = homedir();
  const allSkills: SkillEntry[] = [];

  // Global
  const commandsDir = join(home, ".config", "opencode", "commands");
  const files = findSkillFiles(commandsDir, "*.md");
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const name = basename(filePath, ".md");
      const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
      allSkills.push({ name, description: firstLine.replace(/^#\s*/, "").trim(), scope: "global" });
    } catch { /* skip */ }
  }

  // Project
  if (workdir) {
    const projFiles = findSkillFiles(join(workdir, ".opencode", "commands"), "*.md");
    for (const filePath of projFiles) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const name = basename(filePath, ".md");
        const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
        allSkills.push({ name, description: firstLine.replace(/^#\s*/, "").trim(), scope: "agent" });
      } catch { /* skip */ }
    }
  }

  return allSkills;
}

type Runtime = "claude" | "codex" | "opencode";

export interface SkillScannerConfig {
  workspacesRoot: string;
  workspaces: { workspaceId: string; token: string }[];
  runtimes: Runtime[];
}

const prevHashes: Record<string, string> = {};

function computeHash(skills: SkillEntry[]): string {
  return createHash("md5").update(JSON.stringify(skills)).digest("hex");
}

function writeLocalCache(runtime: Runtime, skills: SkillEntry[]) {
  ensureCacheDir();
  writeFileSync(join(getCacheDir(), `${runtime}.json`), JSON.stringify(skills, null, 2), "utf-8");
}

let scanTimer: ReturnType<typeof setInterval> | null = null;
let scannerConfig: SkillScannerConfig | null = null;
let clientRef: DaemonClient | null = null;

function discoverTargets(): { agentId: string; workdir: string; runtime: Runtime; token: string }[] {
  if (!scannerConfig) return [];
  const rootReal = realpathSync(scannerConfig.workspacesRoot);
  const targets: { agentId: string; workdir: string; runtime: Runtime; token: string }[] = [];
  for (const ws of scannerConfig.workspaces) {
    const wsDir = join(scannerConfig.workspacesRoot, ws.workspaceId);
    let agentDirs: string[] = [];
    try { if (existsSync(wsDir)) agentDirs = readdirSync(wsDir); } catch { continue; }
    for (const agentId of agentDirs) {
      const workdir = join(wsDir, agentId, "workdir");
      if (!existsSync(workdir)) continue;
      try {
        if (!realpathSync(workdir).startsWith(rootReal)) continue;
      } catch { continue; }
      for (const runtime of scannerConfig.runtimes) {
        targets.push({ agentId, workdir, runtime, token: ws.token });
      }
    }
  }
  return targets;
}

function runScan() {
  const targets = discoverTargets();
  if (targets.length === 0) return;

  for (const target of targets) {
    try {
      const scanner = target.runtime === "claude"
        ? scanClaudeSkills
        : target.runtime === "codex"
          ? scanCodexSkills
          : scanOpenCodeSkills;

      const skills = scanner(target.workdir);
      const key = `${target.agentId}:${target.runtime}`;
      const hash = computeHash(skills);

      writeLocalCache(target.runtime, skills);

      if (prevHashes[key] !== hash) {
        prevHashes[key] = hash;
        log.info(`Syncing ${target.agentId}:${target.runtime} — ${skills.length} skills`);
        if (clientRef) {
          clientRef.syncSkills(target.token, {
            agent_id: target.agentId,
            runtime: target.runtime,
            skills,
          }).catch((e) => log.debug("Skill sync failed", e));
        }
      }
    } catch (e) {
      log.debug(`Scan error for ${target.agentId}:${target.runtime}`, e);
    }
  }
}

export function startSkillScanner(
  client: DaemonClient,
  config: SkillScannerConfig,
  interval = 60_000,
): void {
  clientRef = client;
  scannerConfig = config;
  runScan();
  scanTimer = setInterval(runScan, interval);
}

export function stopSkillScanner(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

export function readSkillCache(runtime: Runtime): SkillEntry[] {
  try {
    const filePath = join(getCacheDir(), `${runtime}.json`);
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}
