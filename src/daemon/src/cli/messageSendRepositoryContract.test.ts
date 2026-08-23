import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const excludedDirectories = new Set([
  ".git",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "plans",
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

function repositoryFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;

    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...repositoryFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && scannedExtensions.has(extname(entry.name))) files.push(absolutePath);
  }

  return files;
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

  it("requires --remind-after on every runnable repository invocation", () => {
    const invocations: Array<{ path: string; line: number; text: string }> = [];

    for (const absolutePath of repositoryFiles(repositoryRoot)) {
      const path = relative(repositoryRoot, absolutePath);

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
