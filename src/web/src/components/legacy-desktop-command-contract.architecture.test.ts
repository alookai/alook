import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../", import.meta.url);
const removedCommands = ["get_cli_info", "register_cli", "daemon_start", "cli_update"];

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) return sourceFiles(child);
    if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) return [];
    return [child];
  });
}

describe("legacy desktop command contract", () => {
  it("does not invoke removed Tauri lifecycle commands from reachable web code", () => {
    const violations = sourceFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return removedCommands
        .filter((command) => source.includes(`tauriInvoke(\"${command}\"`) || source.includes(`tauriInvoke<`) && source.includes(`>(\"${command}\"`))
        .map((command) => `${relative(sourceRoot.pathname, file.pathname)}: ${command}`);
    });

    expect(violations).toEqual([]);
  });
});
