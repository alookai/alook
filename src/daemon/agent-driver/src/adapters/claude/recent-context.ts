import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import {
  collectJsonlFileCandidates,
  isMissingPathError,
  type JsonlScanOptions,
  RecentContextCollector,
} from "../../internal/recent-context.js";

interface ClaudeRecentContextDependencies {
  readonly projectsRoot?: string;
  readonly readProjectPath?: (filePath: string) => Promise<string | null>;
  readonly readDirectory?: JsonlScanOptions["readDirectory"];
  readonly statPath?: JsonlScanOptions["statPath"];
}

export async function readClaudeProjectPath(filePath: string): Promise<string | null> {
  const input = createReadStream(filePath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== "object") continue;
      const cwd = (record as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && path.isAbsolute(cwd)) return cwd;
    }
    return null;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function discoverClaudeRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: ClaudeRecentContextDependencies = {},
): Promise<RecentContextDiscoveryData> {
  const collector = new RecentContextCollector(request, "supported");
  if (collector.satisfied) return collector.result();
  const projectsRoot = path.resolve(dependencies.projectsRoot
    ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects"));
  const readProjectPath = dependencies.readProjectPath ?? readClaudeProjectPath;
  const candidates = await collectJsonlFileCandidates(projectsRoot, {
    includeRootFiles: false,
    maxDepth: 1,
    readDirectory: dependencies.readDirectory,
    statPath: dependencies.statPath,
  });

  candidates.sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
  for (const candidate of candidates) {
    const projectPath = await readProjectPath(candidate.filePath);
    if (!projectPath) continue;
    collector.add({
      sessionFilePath: candidate.filePath,
      projectPath,
      modifiedAt: candidate.modifiedAt,
    });
    if (collector.satisfied) break;
  }
  return collector.result();
}
