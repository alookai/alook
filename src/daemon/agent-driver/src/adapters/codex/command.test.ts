import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { probeCliRuntime } from "../../internal/probe.js";
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


describe("explicit Codex sources", () => {
  it("finds two independent programs when PATH and App are installed", () => {
    const f = fixture();
    const app = f.install("Codex");
    f.deps.which.mockReturnValue("/cli/codex");
    expect(resolveCodexCommand(undefined, f.deps, "darwin", "codex-app")).toBe(app);
    expect(f.deps.which).not.toHaveBeenCalled();
    expect(resolveCodexCommand(undefined, f.deps, "darwin", "codex-cli")).toBe("/cli/codex");
  });

  it("does not use the App when the CLI is missing", () => {
    const f = fixture();
    f.install("Codex");
    expect(resolveCodexCommand(undefined, f.deps, "darwin", "codex-cli")).toBeUndefined();
  });

  it("does not use PATH when the App is missing", () => {
    const f = fixture();
    f.deps.which.mockReturnValue("/cli/codex");
    expect(resolveCodexCommand(undefined, f.deps, "darwin", "codex-app")).toBeUndefined();
    expect(f.deps.which).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("does not use PATH as an App on %s", (platform) => {
    const f = fixture();
    f.install("Codex");
    f.deps.which.mockReturnValue("/cli/codex");
    expect(resolveCodexCommand(undefined, f.deps, platform, "codex-app")).toBeUndefined();
  });

  it.each(["codex-app", "codex-cli"] as const)("honors an explicit override for %s", (backend) => {
    const f = fixture();
    expect(resolveCodexCommand(" /custom/codex ", f.deps, "linux", backend)).toBe("/custom/codex");
    expect(f.deps.which).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform === "win32")("executes the selected App and CLI version programs independently", () => {
  const f = fixture();
  const app = f.install("Codex");
  const cli = join(f.deps.homeDir, "standalone-codex");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(app, "#!/bin/sh\nprintf 'codex-app 1.2.3\\n'\n");
  writeFileSync(cli, "#!/bin/sh\nprintf 'codex-cli 4.5.6\\n'\n");
  chmodSync(cli, 0o755);
  f.deps.which.mockReturnValue(cli);
  expect(probeCliRuntime("codex", {}, resolveCodexCommand(undefined, f.deps, "darwin", "codex-app"))).toEqual({ status: "healthy", version: "codex-app 1.2.3" });
  expect(probeCliRuntime("codex", {}, resolveCodexCommand(undefined, f.deps, "darwin", "codex-cli"))).toEqual({ status: "healthy", version: "codex-cli 4.5.6" });
});
