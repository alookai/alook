import { homedir } from "node:os";
import path from "node:path";
import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import {
  collectJsonlFileCandidates,
  type JsonlScanOptions,
  readFirstLine,
  RecentContextCollector,
} from "../../internal/recent-context.js";
import { tryParseJsonRecord } from "../../internal/utils.js";

interface PiRecentContextDependencies {
  readonly sessionsRoot?: string;
  readonly readHeader?: (filePath: string) => Promise<string | null>;
  readonly readDirectory?: JsonlScanOptions["readDirectory"];
  readonly statPath?: JsonlScanOptions["statPath"];
}

function expandTildePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export async function discoverPiRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: PiRecentContextDependencies = {},
): Promise<RecentContextDiscoveryData> {
  const collector = new RecentContextCollector(request, "supported");
  if (collector.satisfied) return collector.result();
  const customSessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
  const sessionsRoot = path.resolve(expandTildePath(dependencies.sessionsRoot
    ?? customSessionDirectory
    ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "sessions")));
  const scanDirectSessions = dependencies.sessionsRoot == null && customSessionDirectory != null;
  const readHeader = dependencies.readHeader ?? readFirstLine;
  const candidates = await collectJsonlFileCandidates(sessionsRoot, {
    includeRootFiles: scanDirectSessions,
    maxDepth: 1,
    readDirectory: dependencies.readDirectory,
    statPath: dependencies.statPath,
  });

  candidates.sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
  for (const candidate of candidates) {
    const line = await readHeader(candidate.filePath);
    if (!line) continue;
    const header = tryParseJsonRecord(line);
    if (!header) continue;
    if (header.type !== "session" || header.parentSession != null) continue;
    collector.add({
      sessionFilePath: candidate.filePath,
      projectPath: header.cwd,
      modifiedAt: candidate.modifiedAt,
    });
    if (collector.satisfied) break;
  }
  return collector.result();
}
