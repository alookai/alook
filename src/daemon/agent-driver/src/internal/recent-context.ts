import path from "node:path";
import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type {
  RecentContextDiscoveryData,
  RecentContextDiscoveryRequest,
  SessionFileDiscoveryCapability,
} from "../contract.js";

export interface RecentContextCandidate {
  readonly projectPath: unknown;
  readonly modifiedAt: unknown;
  readonly sessionFilePath?: unknown;
}

interface JsonlFileCandidate {
  readonly filePath: string;
  readonly modifiedAt: Date;
}

export interface JsonlScanOptions {
  readonly includeRootFiles?: boolean;
  readonly maxDepth?: number;
  readonly readDirectory?: (directory: string) => Promise<readonly Dirent<string>[]>;
  readonly statPath?: typeof stat;
}

function normalizeAbsolutePath(value: unknown): string | null {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  return path.normalize(value);
}

function normalizeModifiedAt(value: unknown): string | null {
  const date = value instanceof Date
    ? value
    : typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

export function isValidRecentContextTopK(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function readFirstLine(filePath: string, maxBytes = 65_536): Promise<string | null> {
  const stream = createReadStream(filePath, { highWaterMark: 1 });
  const bytes: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const byte = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (byte[0] === 0x0a) break;
      if (length >= maxBytes) return null;
      bytes.push(byte);
      length += byte.length;
    }
    return length === 0 ? null : Buffer.concat(bytes, length).toString("utf8").replace(/\r$/, "");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  } finally {
    stream.destroy();
  }
}

export async function collectJsonlFileCandidates(
  root: string,
  options: JsonlScanOptions = {},
): Promise<JsonlFileCandidate[]> {
  const candidates: JsonlFileCandidate[] = [];
  const readDirectory = options.readDirectory
    ?? ((directory: string) => readdir(directory, { withFileTypes: true }));
  const statPath = options.statPath ?? stat;

  const visit = async (directory: string, remainingDepth: number, includeFiles: boolean): Promise<void> => {
    let entries: readonly Dirent<string>[];
    try {
      entries = await readDirectory(directory);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && remainingDepth > 0) {
        await visit(entryPath, remainingDepth - 1, true);
      } else if (includeFiles && entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const metadata = await statPath(entryPath);
          if (metadata.isFile()) candidates.push({ filePath: entryPath, modifiedAt: metadata.mtime });
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
    }));
  };

  await visit(root, options.maxDepth ?? Number.POSITIVE_INFINITY, options.includeRootFiles ?? true);
  return candidates;
}

function retainNewest<K, V extends { readonly modifiedAt: string }>(
  values: Map<K, V>,
  key: K,
  value: V,
  topK: number,
): void {
  const existing = values.get(key);
  if (existing) {
    if (value.modifiedAt > existing.modifiedAt) values.set(key, value);
    return;
  }
  if (values.size < topK) {
    values.set(key, value);
    return;
  }
  let oldest: [K, V] | undefined;
  for (const entry of values) {
    if (!oldest || entry[1].modifiedAt < oldest[1].modifiedAt) oldest = entry;
  }
  if (oldest && value.modifiedAt > oldest[1].modifiedAt) {
    values.delete(oldest[0]);
    values.set(key, value);
  }
}

export class RecentContextCollector {
  private readonly sessions = new Map<string, {
    sessionFilePath: string;
    projectPath: string;
    modifiedAt: string;
  }>();
  private readonly projects = new Map<string, { projectPath: string; modifiedAt: string }>();

  constructor(
    private readonly request: RecentContextDiscoveryRequest,
    private readonly sessionFileCapability: SessionFileDiscoveryCapability,
  ) {}

  add(candidate: RecentContextCandidate, target: "both" | "session" | "project" = "both"): void {
    const projectPath = normalizeAbsolutePath(candidate.projectPath);
    const modifiedAt = normalizeModifiedAt(candidate.modifiedAt);
    if (!projectPath || !modifiedAt) return;

    if (target !== "session") {
      retainNewest(this.projects, projectPath, { projectPath, modifiedAt }, this.request.recentProjectsTopK);
    }

    if (
      target === "project"
      || this.sessionFileCapability !== "supported"
    ) return;
    const sessionFilePath = normalizeAbsolutePath(candidate.sessionFilePath);
    if (!sessionFilePath) return;
    retainNewest(
      this.sessions,
      sessionFilePath,
      { sessionFilePath, projectPath, modifiedAt },
      this.request.recentSessionFilesTopK,
    );
  }

  get satisfied(): boolean {
    const sessionsSatisfied = this.sessionFileCapability === "unavailable"
      || this.sessions.size >= this.request.recentSessionFilesTopK;
    return sessionsSatisfied && this.projects.size >= this.request.recentProjectsTopK;
  }

  result(): RecentContextDiscoveryData {
    const newestFirst = <T extends { readonly modifiedAt: string }>(left: T, right: T) =>
      right.modifiedAt.localeCompare(left.modifiedAt);
    return {
      sessionFiles: {
        capability: this.sessionFileCapability,
        items: [...this.sessions.values()]
          .sort(newestFirst)
          .slice(0, this.request.recentSessionFilesTopK),
      },
      recentProjects: [...this.projects.values()]
        .sort(newestFirst)
        .slice(0, this.request.recentProjectsTopK),
    };
  }
}

export function sanitizeRecentContextData(
  value: unknown,
  request: RecentContextDiscoveryRequest,
): RecentContextDiscoveryData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!candidate.sessionFiles || typeof candidate.sessionFiles !== "object" || Array.isArray(candidate.sessionFiles)) {
    return null;
  }
  const sessionFiles = candidate.sessionFiles as Record<string, unknown>;
  const capability = sessionFiles.capability;
  if ((capability !== "supported" && capability !== "unavailable") || !Array.isArray(sessionFiles.items)) {
    return null;
  }
  if (!Array.isArray(candidate.recentProjects)) return null;

  const collector = new RecentContextCollector(request, capability);
  if (capability === "supported") {
    for (const item of sessionFiles.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      collector.add({
        sessionFilePath: record.sessionFilePath,
        projectPath: record.projectPath,
        modifiedAt: record.modifiedAt,
      }, "session");
    }
  }

  for (const item of candidate.recentProjects) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    collector.add({ projectPath: record.projectPath, modifiedAt: record.modifiedAt }, "project");
  }
  return collector.result();
}
