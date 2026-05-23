import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { createLogger } from "../lib/logger.js";

const log = createLogger("skill-scanner");

export interface SkillEntry {
  name: string;
  description: string;
}

const CACHE_DIR = join(homedir(), ".alook", "skills");

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
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

export function scanClaudeSkills(): SkillEntry[] {
  const home = homedir();
  const skills = new Map<string, SkillEntry>();

  const directPaths = findSkillFiles(join(home, ".claude", "skills"), "*/SKILL.md");
  for (const filePath of directPaths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !skills.has(meta.name)) {
        skills.set(meta.name, meta);
      }
    } catch { /* skip */ }
  }

  const pluginCacheDir = join(home, ".claude", "plugins", "cache");
  const pluginPaths = findSkillFiles(pluginCacheDir, "**/skills/*/SKILL.md");
  for (const filePath of pluginPaths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !skills.has(meta.name)) {
        skills.set(meta.name, meta);
      }
    } catch { /* skip */ }
  }

  return Array.from(skills.values());
}

export function scanCodexSkills(): SkillEntry[] {
  const home = homedir();
  const skills = new Map<string, SkillEntry>();

  const paths = [
    ...findSkillFiles(join(home, ".agents", "skills"), "*/SKILL.md"),
    ...findSkillFiles(join(home, ".codex", "skills", ".system"), "*/SKILL.md"),
  ];

  for (const filePath of paths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !skills.has(meta.name)) {
        skills.set(meta.name, meta);
      }
    } catch { /* skip */ }
  }

  const codexPluginDir = join(home, ".codex", "plugins", "cache");
  const pluginPaths = findSkillFiles(codexPluginDir, "**/skills/*/SKILL.md");
  for (const filePath of pluginPaths) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const meta = parseFrontmatter(content);
      if (meta && !skills.has(meta.name)) {
        skills.set(meta.name, meta);
      }
    } catch { /* skip */ }
  }

  return Array.from(skills.values());
}

export function scanOpenCodeSkills(): SkillEntry[] {
  const home = homedir();
  const commandsDir = join(home, ".config", "opencode", "commands");
  const skills: SkillEntry[] = [];

  const files = findSkillFiles(commandsDir, "*.md");
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const name = basename(filePath, ".md");
      const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
      skills.push({ name, description: firstLine.replace(/^#\s*/, "").trim() });
    } catch { /* skip */ }
  }

  return skills;
}

type Runtime = "claude" | "codex" | "opencode";

const scanners: Record<Runtime, () => SkillEntry[]> = {
  claude: scanClaudeSkills,
  codex: scanCodexSkills,
  opencode: scanOpenCodeSkills,
};

const prevHashes: Record<string, string> = {};

function writeIfChanged(runtime: Runtime, skills: SkillEntry[]) {
  const json = JSON.stringify(skills, null, 2);
  const hash = createHash("md5").update(json).digest("hex");

  if (prevHashes[runtime] === hash) return;
  prevHashes[runtime] = hash;

  ensureCacheDir();
  writeFileSync(join(CACHE_DIR, `${runtime}.json`), json, "utf-8");
  log.debug(`Updated ${runtime}.json (${skills.length} skills)`);
}

function runScan() {
  for (const runtime of Object.keys(scanners) as Runtime[]) {
    try {
      const skills = scanners[runtime]();
      writeIfChanged(runtime, skills);
    } catch (e) {
      log.debug(`Scan error for ${runtime}`, e);
    }
  }
}

let scanTimer: ReturnType<typeof setInterval> | null = null;

export function startSkillScanner(interval = 60_000): void {
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
    const filePath = join(CACHE_DIR, `${runtime}.json`);
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}
