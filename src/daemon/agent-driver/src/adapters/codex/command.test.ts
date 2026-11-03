import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCodexCommand } from "./command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex app discovery "));
  roots.push(root);
  const deps = { homeDir: join(root, "user"), applicationsDirectory: join(root, "Applications"), which: vi.fn((): string | null => null) };
  const install = (app: string, user = false, executable = true) => {
    const binary = join(user ? join(deps.homeDir, "Applications") : deps.applicationsDirectory, `${app}.app`, "Contents", "Resources", "codex");
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, executable ? 0o755 : 0o644);
    return binary;
  };
  return { deps, install };
}

describe("Codex App command discovery", () => {
  it("honors an explicit command without probing other installations", () => {
    const f = fixture();
    f.install("Codex");
    expect(resolveCodexCommand(" /custom codex/bin ", f.deps, "darwin")).toBe("/custom codex/bin");
    expect(f.deps.which).not.toHaveBeenCalled();
  });

  it("keeps PATH ahead of App bundles", () => {
    const f = fixture();
    f.install("Codex");
    f.deps.which.mockReturnValue("/path/codex");
    expect(resolveCodexCommand(undefined, f.deps, "darwin")).toBe("/path/codex");
  });

  it.each(["Codex", "ChatGPT"])("finds the %s App in system and user Applications", (app) => {
    const f = fixture();
    const user = f.install(app, true);
    expect(resolveCodexCommand(undefined, f.deps, "darwin")).toBe(user);
    const system = f.install(app);
    expect(resolveCodexCommand(undefined, f.deps, "darwin")).toBe(system);
  });

  it.skipIf(process.platform === "win32")("skips a non-executable bundle and uses the next runnable candidate", () => {
    const f = fixture();
    f.install("Codex", false, false);
    const usable = f.install("ChatGPT", true);
    expect(resolveCodexCommand(undefined, f.deps, "darwin")).toBe(usable);
  });

  it("prefers Codex over the legacy ChatGPT bundle", () => {
    const f = fixture();
    f.install("ChatGPT");
    const current = f.install("Codex", true);
    expect(resolveCodexCommand(undefined, f.deps, "darwin")).toBe(current);
  });

  it.each(["linux", "win32"] as const)("does not search macOS bundles on %s", (platform) => {
    const f = fixture();
    f.install("Codex");
    expect(resolveCodexCommand(undefined, f.deps, platform)).toBeUndefined();
  });

  it("returns unavailable when no runnable candidate exists", () => {
    expect(resolveCodexCommand(undefined, fixture().deps, "darwin")).toBeUndefined();
  });
});
