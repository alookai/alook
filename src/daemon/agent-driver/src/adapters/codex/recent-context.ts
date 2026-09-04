import path from "node:path";
import type { RecentContextDiscoveryData, RecentContextDiscoveryRequest } from "../../contract.js";
import {
  collectJsonlFileCandidates,
  type JsonlScanOptions,
  readFirstLine,
  RecentContextCollector,
} from "../../internal/recent-context.js";
import { asRecord, tryParseJsonRecord } from "../../internal/utils.js";
import { resolveCodexHomeRootFromEnv } from "./home.js";

interface CodexRecentContextDependencies {
  readonly sessionsRoot?: string;
  readonly readHeader?: (filePath: string) => Promise<string | null>;
  readonly readDirectory?: JsonlScanOptions["readDirectory"];
  readonly statPath?: JsonlScanOptions["statPath"];
}

function isChildSession(payload: Record<string, unknown>): boolean {
  if (payload.parentThreadId != null || payload.parent_thread_id != null) return true;
  const source = payload.source;
  if (typeof source === "string") return source.toLowerCase().startsWith("subagent");
  const sourceRecord = asRecord(source);
  return sourceRecord != null && ("subagent" in sourceRecord || "subAgent" in sourceRecord);
}

export async function discoverCodexRecentContext(
  request: RecentContextDiscoveryRequest,
  dependencies: CodexRecentContextDependencies = {},
): Promise<RecentContextDiscoveryData> {
  const collector = new RecentContextCollector(request, "supported");
  if (collector.satisfied) return collector.result();
  const sessionsRoot = path.resolve(dependencies.sessionsRoot
    ?? path.join(resolveCodexHomeRootFromEnv(), "sessions"));
  const readHeader = dependencies.readHeader ?? readFirstLine;
  const candidates = await collectJsonlFileCandidates(sessionsRoot, {
    readDirectory: dependencies.readDirectory,
    statPath: dependencies.statPath,
  });
  candidates.sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());

  for (const candidate of candidates) {
    const line = await readHeader(candidate.filePath);
    if (!line) continue;
    const header = tryParseJsonRecord(line);
    if (!header) continue;
    const payload = asRecord(header.payload);
    if (header.type !== "session_meta" || !payload || isChildSession(payload)) continue;
    collector.add({
      sessionFilePath: candidate.filePath,
      projectPath: payload.cwd,
      modifiedAt: candidate.modifiedAt,
    });
    if (collector.satisfied) break;
  }
  return collector.result();
}
