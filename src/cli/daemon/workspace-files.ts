import { readdir, stat, readFile } from "fs/promises";
import { join, resolve, extname, relative } from "path";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".wrangler", "__pycache__", ".venv"]);

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".js", ".ts", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".toml", ".yaml", ".yml",
  ".html", ".css", ".scss", ".sh", ".bash", ".zsh",
  ".env", ".cfg", ".ini", ".xml", ".svg", ".sql",
  ".jsonl", ".log", ".csv",
]);

const MAX_FILE_SIZE = 1_048_576; // 1MB

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export async function readDirectoryTree(
  dirPath: string,
  basePath: string,
): Promise<FileEntry[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const results: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".context_timeline") continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    let info;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }

    results.push({
      name: entry.name,
      path: relative(basePath, fullPath),
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? 0 : info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return results;
}

export async function readFileContent(
  filePath: string,
): Promise<{ content: string | null; isBinary: boolean }> {
  const info = await stat(filePath);
  if (info.isDirectory()) throw new Error("Cannot read a directory");
  if (info.size > MAX_FILE_SIZE) throw new Error("File too large (>1MB)");

  const ext = extname(filePath).toLowerCase();
  if (ext !== "" && !TEXT_EXTENSIONS.has(ext)) {
    return { content: null, isBinary: true };
  }

  const content = await readFile(filePath, "utf-8");
  return { content, isBinary: false };
}

export function validatePath(agentWorkdir: string, requestedPath: string): string | null {
  const resolved = resolve(agentWorkdir, requestedPath);
  if (!resolved.startsWith(agentWorkdir)) return null;
  return resolved;
}
