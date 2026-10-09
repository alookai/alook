import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  resolveCommandOnPath,
  resolveClaudeCommand,
  resolveSpawnSpec,
  probeCliRuntime,
  probeCommandOutput,
  probeCommandVersion,
} from "./probe.js";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

/**
 * `resolveSpawnSpec` is what makes Cursor/OpenCode/Codex spawnable on Windows
 * when the CLI resolves to a
 * `.cmd`/`.bat` shim, which `child_process.spawn` can only exec through a
 * shell.
 */
describe("resolveSpawnSpec", () => {
  it("sets shell: true on win32 when the resolved binary is a .cmd shim", () => {
    const spec = resolveSpawnSpec(
      "cursor-agent",
      ["--print"],
      undefined,
      { which: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\cursor-agent.cmd" },
      "win32",
    );
    expect(spec).toEqual({
      command: "C:\\Users\\me\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      args: ["--print"],
      shell: true,
    });
  });

  it("sets shell: true on win32 when the resolved binary is a .bat shim", () => {
    const spec = resolveSpawnSpec("opencode", [], undefined, { which: () => "C:\\tools\\opencode.bat" }, "win32");
    expect(spec.shell).toBe(true);
  });

  it("does not set shell when the resolved binary is a native .exe on win32", () => {
    const spec = resolveSpawnSpec("codex", [], undefined, { which: () => "C:\\tools\\codex.exe" }, "win32");
    expect(spec.shell).toBe(false);
  });

  it("never sets shell on POSIX, even for a path that looks like a shim", () => {
    const spec = resolveSpawnSpec("opencode", [], undefined, { which: () => "/usr/local/bin/opencode.cmd" }, "darwin");
    expect(spec.shell).toBe(false);
  });

  it("falls back to the bare command name when PATH resolution fails, without a shell on POSIX", () => {
    const spec = resolveSpawnSpec("opencode", ["serve"], undefined, { which: () => null }, "linux");
    expect(spec).toEqual({ command: "opencode", args: ["serve"], shell: false });
  });

  it("honors an absolute-path override without re-resolving via PATH", () => {
    const which = vi.fn(() => "/should/not/be/called");
    const spec = resolveSpawnSpec("codex", ["run"], "/custom/bin/codex", { which }, "linux");
    expect(spec.command).toBe("/custom/bin/codex");
    expect(which).not.toHaveBeenCalled();
  });

  it("resolves a bare-name override via PATH (so a user can point at a differently-named binary)", () => {
    const which = vi.fn(() => "/opt/opencode-custom/bin/opencode-alt");
    const spec = resolveSpawnSpec("opencode", [], "opencode-alt", { which }, "linux");
    expect(spec.command).toBe("/opt/opencode-custom/bin/opencode-alt");
    expect(which).toHaveBeenCalledWith("opencode-alt");
  });

  it("treats empty or whitespace-only override as absent (falls back to command)", () => {
    const which = vi.fn(() => "/usr/local/bin/codex");
    const spec = resolveSpawnSpec("codex", [], "   ", { which }, "linux");
    expect(spec.command).toBe("/usr/local/bin/codex");
    expect(which).toHaveBeenCalledWith("codex");
  });
});

describe("resolveClaudeCommand", () => {
  it("uses the macOS per-user app fallback when PATH has no Claude binary", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "claude-probe-home-"));
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const executable = join(
        homeDir,
        "Applications/Claude Code URL Handler.app/Contents/MacOS/claude",
      );
      mkdirSync(join(executable, ".."), { recursive: true });
      writeFileSync(executable, "");
      expect(resolveClaudeCommand({
        homeDir,
        which: () => null,
      })).toBe(executable);
    } finally {
      platform.mockRestore();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

/**
 * Regression tests: `probeCommandVersion` — used by every non-Pi driver's
 * `probe()` via `probeCliRuntime`/`probeClaude` — must agree with
 * `resolveSpawnSpec` about whether a resolved binary needs a shell. Before
 * this fix, a `.cmd`/`.bat` shim spawned fine (via `resolveSpawnSpec`) but
 * still failed its own health probe on Windows (`execFileSync` with no
 * `shell` option can't exec a `.cmd`/`.bat` directly), which reported the
 * runtime as `unhealthy` and hid it from the UI even though it actually
 * worked.
 */
describe("probeCommandVersion — Windows shim shell parity with resolveSpawnSpec", () => {
  it("runs .cmd shims through a shell on win32", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("C:\\Users\\me\\AppData\\Roaming\\npm\\cursor-agent.cmd", [], {}, "win32");

    expect(execFileSync).toHaveBeenCalledWith(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      ["--version"],
      expect.objectContaining({ shell: true }),
    );
  });

  it("runs .bat shims through a shell on win32", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("C:\\tools\\opencode.bat", [], {}, "win32");

    expect(execFileSync).toHaveBeenCalledWith("C:\\tools\\opencode.bat", ["--version"], expect.objectContaining({ shell: true }));
  });

  it("does not use a shell for a native .exe on win32", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("C:\\tools\\codex.exe", [], {}, "win32");

    expect(execFileSync).toHaveBeenCalledWith("C:\\tools\\codex.exe", ["--version"], expect.objectContaining({ shell: false }));
  });

  it("never uses a shell on POSIX, even for a path that looks like a shim", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("/usr/local/bin/opencode.cmd", [], {}, "darwin");

    expect(execFileSync).toHaveBeenCalledWith("/usr/local/bin/opencode.cmd", ["--version"], expect.objectContaining({ shell: false }));
  });
});

/**
 * Version-shape validation + non-interactive spawn. An installation prompt has
 * no version token, so it must be rejected as
 * `invalid_version_output` rather than surfacing as a bogus "version". These
 * assert on the RETURNED result (the older tests only assert call args), so the
 * validation is actually covered.
 */
describe("probeCommandVersion — version validation + non-interactive spawn", () => {
  it("rejects an interactive install prompt (exit 0, no version token)", () => {
    vi.mocked(execFileSync).mockReturnValue("Install runtime CLI? ['y/N'] ");

    const result = probeCommandVersion("runtime-cli", [], {}, "darwin");

    expect(result).toEqual({ ok: false, error: "invalid_version_output" });
  });

  it("rejects a non-version first line", () => {
    vi.mocked(execFileSync).mockReturnValue("Cannot find runtime CLI\n");

    expect(probeCommandVersion("runtime-cli", [], {}, "darwin")).toEqual({
      ok: false,
      error: "invalid_version_output",
    });
  });

  it("returns empty_version_output for blank output", () => {
    vi.mocked(execFileSync).mockReturnValue("\n");

    expect(probeCommandVersion("runtime-cli", [], {}, "darwin")).toEqual({
      ok: false,
      error: "empty_version_output",
    });
  });

  it("accepts a plain semver", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    expect(probeCommandVersion("claude", [], {}, "darwin")).toEqual({ ok: true, version: "1.2.3" });
  });

  it("accepts a v-prefixed version and keeps the whole line", () => {
    vi.mocked(execFileSync).mockReturnValue("codex v0.4\n");

    expect(probeCommandVersion("codex", [], {}, "darwin")).toEqual({ ok: true, version: "codex v0.4" });
  });

  it("spawns non-interactively: empty stdin + CI env, stdout still piped", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("opencode", [], {}, "darwin");

    expect(execFileSync).toHaveBeenCalledWith(
      "opencode",
      ["--version"],
      expect.objectContaining({
        input: "",
        encoding: "utf8",
        env: expect.objectContaining({ CI: "1" }),
      }),
    );
  });
});

describe("probeCliRuntime command override", () => {
  it("probes the explicit command without resolving the default binary", () => {
    vi.mocked(execFileSync).mockReturnValue("custom v6.0.0\n");
    const which = vi.fn(() => "/default/runtime");

    expect(probeCliRuntime("default-runtime", { which }, "/custom/runtime")).toEqual({
      status: "healthy",
      version: "custom v6.0.0",
    });
    expect(which).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledWith(
      "/custom/runtime",
      ["--version"],
      expect.any(Object),
    );
  });
});

describe("probeCommandOutput", () => {
  it("runs the exact command and args with bounded, non-interactive options", () => {
    vi.mocked(execFileSync).mockReturnValue("provider/model\n");

    expect(probeCommandOutput("/custom/opencode", ["models", "--pure"], "darwin"))
      .toEqual({ ok: true, output: "provider/model\n" });
    expect(execFileSync).toHaveBeenCalledWith(
      "/custom/opencode",
      ["models", "--pure"],
      expect.objectContaining({
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        input: "",
        shell: false,
        env: expect.objectContaining({ CI: "1" }),
      }),
    );
  });

  it("uses a shell for Windows shims and converts failures to a non-throwing result", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      const error = new Error("timed out") as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      throw error;
    });

    expect(probeCommandOutput("C:\\tools\\cursor-agent.cmd", ["--list-models"], "win32"))
      .toEqual({ ok: false, error: "ETIMEDOUT" });
    expect(execFileSync).toHaveBeenCalledWith(
      "C:\\tools\\cursor-agent.cmd",
      ["--list-models"],
      expect.objectContaining({ shell: true }),
    );
  });
});


describe("Windows npm PATH resolution", () => {
  it.each(["codex", "opencode", "claude", "cursor-agent", "grok", "pi"])("probes %s via its .cmd instead of the npm POSIX shim", (binary) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const root = "C:\\Users\\me\\AppData\\Roaming\\npm";
    const shim = `${root}\\${binary}.cmd`;
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === "where") return `${root}\\${binary}\r\n${shim}\r\n`;
      if (command === shim) return "1.2.3\r\n";
      throw Object.assign(new Error("not a Windows executable"), { code: "EINVAL" });
    });
    try {
      expect(probeCliRuntime(binary)).toEqual({ status: "healthy", version: "1.2.3" });
      expect(resolveSpawnSpec(binary, ["serve"])).toEqual({ command: shim, args: ["serve"], shell: true });
    } finally {
      platform.mockRestore();
    }
  });

  it.each(["CMD", "bat", "exe", "com"])("keeps the first runnable .%s entry in PATH order", (extension) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const first = `C:\\first\\runtime.${extension}`;
    vi.mocked(execFileSync).mockReturnValue(`\r\nC:\\first\\runtime\r\nC:\\first\\runtime.ps1\r\n${first}\r\nC:\\second\\runtime.cmd\r\n`);
    try {
      expect(resolveCommandOnPath("runtime")).toBe(first);
    } finally {
      platform.mockRestore();
    }
  });

  it.each(["", "C:\\npm\\codex\r\nC:\\npm\\codex.ps1\r\n"])("rejects lookup output without a runnable Windows entry: %j", (output) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(execFileSync).mockReturnValue(output);
    try {
      expect(probeCliRuntime("codex")).toEqual({ status: "unhealthy", lastError: "not_on_path" });
    } finally {
      platform.mockRestore();
    }
  });

  it("preserves POSIX extensionless command lookup", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.mocked(execFileSync).mockReturnValue("/usr/local/bin/codex\n");
    try {
      expect(resolveCommandOnPath("codex")).toBe("/usr/local/bin/codex");
    } finally {
      platform.mockRestore();
    }
  });
});


describe("Windows shim paths with spaces", () => {
  const command = "C:\\Users\\Alook User\\AppData\\Roaming\\npm\\codex.cmd";

  it("quotes the executable for version probes", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");
    expect(probeCommandVersion(command, [], {}, "win32")).toEqual({ ok: true, version: "1.2.3" });
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[0]).toBe(`"${command}"`);
  });

  it("quotes the executable for model catalog probes", () => {
    vi.mocked(execFileSync).mockReturnValue("provider/model\n");
    expect(probeCommandOutput(command, ["models", "--pure"], "win32")).toEqual({ ok: true, output: "provider/model\n" });
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[0]).toBe(`"${command}"`);
  });
});
