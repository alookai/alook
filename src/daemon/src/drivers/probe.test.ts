import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "child_process";
import { resolveSpawnSpec, probeCommandVersion } from "./probe";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

/**
 * `resolveSpawnSpec` is what makes Cursor/Copilot/Antigravity/Kimi/OpenCode
 * (and Codex/Gemini) spawnable on Windows when the CLI resolves to a
 * `.cmd`/`.bat` shim, which `child_process.spawn` can only exec through a
 * shell. See plans/other-drivers-audit-fixes.md finding #2.
 */
describe("resolveSpawnSpec", () => {
  it("sets shell: true on win32 when the resolved binary is a .cmd shim", () => {
    const spec = resolveSpawnSpec(
      "cursor-agent",
      ["--print"],
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
    const spec = resolveSpawnSpec("kimi", [], { which: () => "C:\\tools\\kimi.bat" }, "win32");
    expect(spec.shell).toBe(true);
  });

  it("does not set shell when the resolved binary is a native .exe on win32", () => {
    const spec = resolveSpawnSpec("copilot", [], { which: () => "C:\\tools\\copilot.exe" }, "win32");
    expect(spec.shell).toBe(false);
  });

  it("never sets shell on POSIX, even for a path that looks like a shim", () => {
    const spec = resolveSpawnSpec("agy", [], { which: () => "/usr/local/bin/agy.cmd" }, "darwin");
    expect(spec.shell).toBe(false);
  });

  it("falls back to the bare command name when PATH resolution fails, without a shell on POSIX", () => {
    const spec = resolveSpawnSpec("opencode", ["run"], { which: () => null }, "linux");
    expect(spec).toEqual({ command: "opencode", args: ["run"], shell: false });
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

    probeCommandVersion("C:\\tools\\kimi.bat", [], {}, "win32");

    expect(execFileSync).toHaveBeenCalledWith("C:\\tools\\kimi.bat", ["--version"], expect.objectContaining({ shell: true }));
  });

  it("does not use a shell for a native .exe on win32", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("C:\\tools\\copilot.exe", [], {}, "win32");

    expect(execFileSync).toHaveBeenCalledWith("C:\\tools\\copilot.exe", ["--version"], expect.objectContaining({ shell: false }));
  });

  it("never uses a shell on POSIX, even for a path that looks like a shim", () => {
    vi.mocked(execFileSync).mockReturnValue("1.2.3\n");

    probeCommandVersion("/usr/local/bin/agy.cmd", [], {}, "darwin");

    expect(execFileSync).toHaveBeenCalledWith("/usr/local/bin/agy.cmd", ["--version"], expect.objectContaining({ shell: false }));
  });
});

/**
 * Version-shape validation + non-interactive spawn — the fix for the GitHub
 * Copilot shim that prints `Install GitHub Copilot CLI? ['y/N']` and exits 0.
 * The shim's prompt has no version token, so it must be rejected as
 * `invalid_version_output` rather than surfacing as a bogus "version". These
 * assert on the RETURNED result (the older tests only assert call args), so the
 * validation is actually covered.
 */
describe("probeCommandVersion — version validation + non-interactive spawn", () => {
  it("rejects the Copilot install prompt (exit 0, no version token)", () => {
    vi.mocked(execFileSync).mockReturnValue("Install GitHub Copilot CLI? ['y/N'] ");

    const result = probeCommandVersion("copilot", [], {}, "darwin");

    expect(result).toEqual({ ok: false, error: "invalid_version_output" });
  });

  it("rejects a non-version first line", () => {
    vi.mocked(execFileSync).mockReturnValue("Cannot find GitHub Copilot CLI\n");

    expect(probeCommandVersion("copilot", [], {}, "darwin")).toEqual({
      ok: false,
      error: "invalid_version_output",
    });
  });

  it("returns empty_version_output for blank output", () => {
    vi.mocked(execFileSync).mockReturnValue("\n");

    expect(probeCommandVersion("copilot", [], {}, "darwin")).toEqual({
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

    probeCommandVersion("gemini", [], {}, "darwin");

    expect(execFileSync).toHaveBeenCalledWith(
      "gemini",
      ["--version"],
      expect.objectContaining({
        input: "",
        encoding: "utf8",
        env: expect.objectContaining({ CI: "1" }),
      }),
    );
  });
});
