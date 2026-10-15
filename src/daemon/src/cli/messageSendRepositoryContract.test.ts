import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scannedExtensions = new Set([
  ".bash",
  ".cjs",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
  ".zsh",
]);
const commandWordsPattern = String.raw`message\s+send`;

// These are parser/audit fixtures or explanatory prose, never runnable CLI examples.
// Keep the allowlist exact so a newly added invocation still has to carry the flag.
const nonRunnableInvocationAllowlist = new Map<string, RegExp[]>([
  [
    "src/daemon/src/manager/managerRuntime.test.ts",
    [
      new RegExp(String.raw`input: \{ command: "  alook ${commandWordsPattern} @gus hi" \}`),
      new RegExp(String.raw`extractToolAudit\("Bash", \{ command: "  alook\s+${commandWordsPattern}" \}\)`),
      new RegExp(String.raw`isAlookShellInvocation\("  alook ${commandWordsPattern}"\)`),
      new RegExp(String.raw`isAlookShellInvocation\("\$\{ALOOK_CLI\} ${commandWordsPattern}"\)`),
      new RegExp(String.raw`runtime_event.*command: "alook ${commandWordsPattern}"`),
    ],
  ],
  [
    "src/daemon/src/daemon/createDaemon.ts",
    [new RegExp(String.raw`Implicit typing\.stop on \`alook ${commandWordsPattern}\``)],
  ],
]);

const environmentCliPattern = String.raw`(?:\$ALOOK_CLI|\$\{ALOOK_CLI\}|\$\{CLI\})`;
const invocationPattern = new RegExp(
  String.raw`(?:\balook|"${environmentCliPattern}"|${environmentCliPattern})\s+${commandWordsPattern}\b`,
);

function isMessageSendInvocation(text: string): boolean {
  return invocationPattern.test(text);
}

function hasRequiredReminderFlag(text: string): boolean {
  return text.includes("--remind-after");
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function repositoryGit(directory: string, args: string[]): string {
  const env = { ...process.env };
  if (directory !== repositoryRoot) {
    const localVariables = execFileSync("git", ["rev-parse", "--local-env-vars"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim().split("\n");
    for (const name of localVariables) delete env[name];
  }
  return execFileSync("git", args, { cwd: directory, env, encoding: "utf8" });
}

function repositoryFiles(directory: string): string[] {
  const paths = repositoryGit(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const files: string[] = [];
  const directories = new Map<string, boolean>();

  for (const path of new Set(paths)) {
    if (!scannedExtensions.has(extname(path))) continue;

    let parent = directory;
    const regularParents = path.split("/").slice(0, -1).every((part) => {
      parent = join(parent, part);
      const regularDirectory = directories.get(parent) ?? lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() ?? false;
      directories.set(parent, regularDirectory);
      return regularDirectory;
    });
    if (!regularParents) continue;

    const absolutePath = join(directory, path);
    if (lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) files.push(absolutePath);
  }

  return files;
}

function withRepository(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "message-send-contract-"));
  try {
    repositoryGit(directory, ["init", "--quiet"]);
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeRepositoryFile(directory: string, path: string, content: string): void {
  const absolutePath = join(directory, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

describe("message send repository contract", () => {
  const commandWords = ["message", "send"].join(" ");
  const environmentPrefixes = ["$" + "ALOOK_CLI", "${" + "ALOOK_CLI}", "${" + "CLI}"];
  const executablePrefixes = ["alook", ...environmentPrefixes.flatMap((prefix) => [prefix, `"${prefix}"`])];

  it.each(executablePrefixes)("recognizes executable prefix %s and enforces the flag", (prefix) => {
    const missingFlag = `${prefix} ${commandWords} --target /demo#1234/general --stdin`;
    const withFlag = `${prefix} ${commandWords} --target /demo#1234/general --remind-after 0 --stdin`;

    expect(isMessageSendInvocation(missingFlag)).toBe(true);
    expect(hasRequiredReminderFlag(missingFlag)).toBe(false);
    expect(isMessageSendInvocation(withFlag)).toBe(true);
    expect(hasRequiredReminderFlag(withFlag)).toBe(true);
  });

  it("does not classify prose or implementation errors as invocations", () => {
    const nonInvocations = [
      `Use ${commandWords} when discussing the feature in prose.`,
      `${commandWords}: --target <ref> is required`,
      `The community ${commandWords} rate limit is shared.`,
    ];

    expect(nonInvocations.map(isMessageSendInvocation)).toEqual([false, false, false]);
  });

  it("normalizes Windows repository paths before exact allowlist matching", () => {
    expect(normalizeRepositoryPath(String.raw`src\daemon\src\manager\managerRuntime.test.ts`)).toBe(
      "src/daemon/src/manager/managerRuntime.test.ts",
    );
  });

  it("scans tracked and nonignored new files without ignored artifacts", () => {
    withRepository((directory) => {
      const invocation = executablePrefixes[0] + " " + commandWords;
      const legal = invocation + " --target /demo#1234/general --remind-after 0 --stdin";
      const malformed = invocation + " --target /demo#1234/general --stdin";
      writeRepositoryFile(directory, ".gitignore", ".next/\n.open-next/\nbundled/\n.alook-qa-scratch/\n");
      writeRepositoryFile(directory, ".git/info/exclude", "local-only.md\n");
      writeRepositoryFile(directory, ".global-ignore", "global-only.md\n");
      repositoryGit(directory, ["config", "core.excludesFile", join(directory, ".global-ignore")]);
      writeRepositoryFile(directory, "source/tracked.ts", legal);
      writeRepositoryFile(directory, ".next/tracked.md", legal);
      writeRepositoryFile(directory, "source/deleted.md", legal);
      repositoryGit(directory, ["add", "--force", "--", "source", ".next/tracked.md"]);
      rmSync(join(directory, "source/deleted.md"));
      writeRepositoryFile(directory, "new example 中文.md", legal);
      writeRepositoryFile(directory, "unsupported.png", malformed);
      for (const path of [
        ".next/build.js",
        ".open-next/worker.js",
        "bundled/runner.js",
        ".alook-qa-scratch/raw.json",
        "local-only.md",
        "global-only.md",
      ]) {
        writeRepositoryFile(directory, path, malformed);
      }
      writeRepositoryFile(directory, "nested/.gitignore", ".cache/\n");
      writeRepositoryFile(directory, "nested/.cache/copy.ts", malformed);
      const expected = [".next/tracked.md", "new example 中文.md", "source/tracked.ts"];
      if (process.platform !== "win32") {
        writeRepositoryFile(directory, "new\nexample.txt", legal);
        expected.push("new\nexample.txt");
      }

      expect(repositoryFiles(directory).map((path) => normalizeRepositoryPath(relative(directory, path))).sort()).toEqual(
        expected.sort(),
      );
    });
  });

  it("isolates foreign repository commands from outer Git environment", () => {
    withRepository((outerDirectory) => {
      writeRepositoryFile(outerDirectory, "outer.md", "");
      repositoryGit(outerDirectory, ["add", "--", "outer.md"]);
      const indexPath = join(outerDirectory, ".git/index");
      const configPath = join(outerDirectory, ".git/config");
      const outerIndex = readFileSync(indexPath);
      const outerConfig = readFileSync(configPath);
      vi.stubEnv("GIT_DIR", join(outerDirectory, ".git"));
      vi.stubEnv("GIT_INDEX_FILE", indexPath);
      vi.stubEnv("GIT_WORK_TREE", outerDirectory);
      try {
        withRepository((directory) => {
          writeRepositoryFile(directory, ".gitignore", "tracked.md\n");
          writeRepositoryFile(directory, ".git/info/exclude", "local-only.md\n");
          writeRepositoryFile(directory, ".global-ignore", "global-only.md\n");
          repositoryGit(directory, ["config", "core.excludesFile", join(directory, ".global-ignore")]);
          writeRepositoryFile(directory, "tracked.md", "");
          repositoryGit(directory, ["add", "--force", "--", "tracked.md"]);
          writeRepositoryFile(directory, "new.md", "");
          writeRepositoryFile(directory, "local-only.md", "");
          writeRepositoryFile(directory, "global-only.md", "");

          expect(repositoryFiles(directory).map((path) => relative(directory, path)).sort()).toEqual(["new.md", "tracked.md"]);
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(readFileSync(indexPath)).toEqual(outerIndex);
      expect(readFileSync(configPath)).toEqual(outerConfig);
    });
  });

  it("does not follow symlink files or tracked paths behind symlink directories", () => {
    withRepository((directory) => {
      writeRepositoryFile(directory, ".gitignore", "outside/\n");
      writeRepositoryFile(directory, "source/replaced/file.md", "");
      writeRepositoryFile(directory, "file-link.md", "");
      repositoryGit(directory, ["add", "--", "source", "file-link.md"]);
      writeRepositoryFile(directory, "outside/file.md", executablePrefixes[0] + " " + commandWords);
      rmSync(join(directory, "source/replaced"), { recursive: true });
      rmSync(join(directory, "file-link.md"));
      symlinkSync(join(directory, "outside"), join(directory, "source/replaced"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(join(directory, "outside/file.md"), join(directory, "file-link.md"), "file");

      expect(repositoryFiles(directory)).toEqual([]);
    });
  });

  it("requires --remind-after on every runnable repository invocation", () => {
    const invocations: Array<{ path: string; line: number; text: string }> = [];

    for (const absolutePath of repositoryFiles(repositoryRoot)) {
      const path = normalizeRepositoryPath(relative(repositoryRoot, absolutePath));

      for (const [lineIndex, text] of readFileSync(absolutePath, "utf8").split("\n").entries()) {
        if (isMessageSendInvocation(text)) invocations.push({ path, line: lineIndex + 1, text: text.trim() });
      }
    }

    const usedAllowlistEntries = new Set<string>();
    const missingRequiredFlag = invocations.filter((invocation) => {
      const allowlist = nonRunnableInvocationAllowlist.get(invocation.path) ?? [];
      const allowlistIndex = allowlist.findIndex((pattern) => pattern.test(invocation.text));
      if (allowlistIndex !== -1) {
        usedAllowlistEntries.add(`${invocation.path}:${allowlistIndex}`);
        return false;
      }
      return !hasRequiredReminderFlag(invocation.text);
    });

    const unusedAllowlistEntries = [...nonRunnableInvocationAllowlist].flatMap(([path, patterns]) =>
      patterns.flatMap((_, index) => (usedAllowlistEntries.has(`${path}:${index}`) ? [] : [`${path}:${index}`])),
    );

    expect(invocations.length).toBeGreaterThan(0);
    expect(missingRequiredFlag).toEqual([]);
    expect(unusedAllowlistEntries).toEqual([]);
  });
});
