import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunNpmUpdate = vi.fn();
vi.mock("../lib/update.js", () => ({
  runNpmUpdate: (...args: any[]) => mockRunNpmUpdate(...args),
}));
vi.mock("../lib/logger.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
vi.mock("fs", () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
}));

vi.mock("./config.js", () => ({
  lastUpdateMarkerPath: vi.fn((profile?: string) =>
    profile ? `/tmp/alook/last_update_${profile}` : "/tmp/alook/last_update",
  ),
}));

import {
  handleCliUpdate,
  isUpdating,
  resetUpdateState,
  readUpdateMarker,
  writeUpdateMarker,
  clearUpdateMarker,
} from "./update-handler";

describe("update-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpdateState();
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
  });

  it("calls runNpmUpdate and invokes onSuccess on success", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: true, output: "ok" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(mockRunNpmUpdate).toHaveBeenCalledWith("1.0.0");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("writes marker file after successful update", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: true, output: "ok" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/alook/last_update",
      "1.0.0",
      { mode: 0o600 },
    );
  });

  it("does not call onSuccess on failure", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: false, output: "error" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not write marker file on failure", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: false, output: "error" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("skips update when marker file matches target version", async () => {
    mockReadFileSync.mockReturnValue("1.0.0");
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(mockRunNpmUpdate).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("proceeds with update when marker file has different version", async () => {
    mockReadFileSync.mockReturnValue("0.9.0");
    mockRunNpmUpdate.mockResolvedValue({ success: true, output: "ok" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(mockRunNpmUpdate).toHaveBeenCalledWith("1.0.0");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("retries up to 3 times then stops", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: false, output: "fail" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);
    await handleCliUpdate("1.0.0", onSuccess);
    await handleCliUpdate("1.0.0", onSuccess);
    await handleCliUpdate("1.0.0", onSuccess); // should be skipped

    expect(mockRunNpmUpdate).toHaveBeenCalledTimes(3);
  });

  it("prevents concurrent updates", async () => {
    let resolve: () => void;
    mockRunNpmUpdate.mockReturnValue(
      new Promise((r) => { resolve = () => r({ success: true, output: "" }); }),
    );
    const onSuccess = vi.fn();

    const p1 = handleCliUpdate("1.0.0", onSuccess);
    expect(isUpdating()).toBe(true);

    // second call while first is in-flight should be a no-op
    await handleCliUpdate("1.0.0", onSuccess);
    expect(mockRunNpmUpdate).toHaveBeenCalledTimes(1);

    resolve!();
    await p1;
    expect(isUpdating()).toBe(false);
  });
});

describe("update marker helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readUpdateMarker returns version from file", () => {
    mockReadFileSync.mockReturnValue("1.2.3\n");
    expect(readUpdateMarker()).toBe("1.2.3");
  });

  it("readUpdateMarker returns null when file does not exist", () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(readUpdateMarker()).toBeNull();
  });

  it("writeUpdateMarker writes version to file", () => {
    writeUpdateMarker("2.0.0");
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/alook/last_update",
      "2.0.0",
      { mode: 0o600 },
    );
  });

  it("writeUpdateMarker uses profile path when provided", () => {
    writeUpdateMarker("2.0.0", "staging");
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/tmp/alook/last_update_staging",
      "2.0.0",
      { mode: 0o600 },
    );
  });

  it("clearUpdateMarker deletes the marker file", () => {
    clearUpdateMarker();
    expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/alook/last_update");
  });

  it("clearUpdateMarker does not throw when file is missing", () => {
    mockUnlinkSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(() => clearUpdateMarker()).not.toThrow();
  });
});
