import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetCurrentVersion = vi.fn();
const mockFetchLatestVersion = vi.fn();
const mockRunNpmUpdate = vi.fn();

vi.mock("../lib/update.js", () => ({
  getCurrentVersion: () => mockGetCurrentVersion(),
  fetchLatestVersion: () => mockFetchLatestVersion(),
  runNpmUpdate: (...args: any[]) => mockRunNpmUpdate(...args),
}));

vi.mock("@alook/shared", () => ({
  semverGte: (a: string, b: string) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const sa = pa[i] ?? 0;
      const sb = pb[i] ?? 0;
      if (sa > sb) return true;
      if (sa < sb) return false;
    }
    return true;
  },
}));

import { updateCommand } from "./update";

describe("alook update", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no daemon")));
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    mockExit.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows 'already up to date' when on latest version", async () => {
    mockGetCurrentVersion.mockReturnValue("1.0.0");
    mockFetchLatestVersion.mockResolvedValue("1.0.0");

    const cmd = updateCommand();
    await cmd.parseAsync(["node", "update"]);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("up to date"));
  });

  it("runs npm install when newer version available", async () => {
    mockGetCurrentVersion.mockReturnValue("0.5.0");
    mockFetchLatestVersion.mockResolvedValue("1.0.0");
    mockRunNpmUpdate.mockResolvedValue({ success: true, output: "" });

    const cmd = updateCommand();
    await cmd.parseAsync(["node", "update"]);

    expect(mockRunNpmUpdate).toHaveBeenCalledWith("1.0.0");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Updated successfully"));
  });

  it("handles network errors gracefully", async () => {
    mockGetCurrentVersion.mockReturnValue("0.5.0");
    mockFetchLatestVersion.mockResolvedValue(null);

    const cmd = updateCommand();
    await cmd.parseAsync(["node", "update"]);

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch"));
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("warns when daemon health endpoint is reachable", async () => {
    mockGetCurrentVersion.mockReturnValue("0.5.0");
    mockFetchLatestVersion.mockResolvedValue("1.0.0");
    mockRunNpmUpdate.mockResolvedValue({ success: true, output: "" });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    const cmd = updateCommand();
    await cmd.parseAsync(["node", "update"]);

    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("daemon is running"));
  });
});
