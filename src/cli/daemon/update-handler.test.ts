import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunNpmUpdate = vi.fn();
vi.mock("../lib/update.js", () => ({
  runNpmUpdate: (...args: any[]) => mockRunNpmUpdate(...args),
}));
vi.mock("../lib/logger.js", () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { handleCliUpdate, isUpdating, resetUpdateState } from "./update-handler";

describe("update-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUpdateState();
  });

  it("calls runNpmUpdate and invokes onSuccess on success", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: true, output: "ok" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(mockRunNpmUpdate).toHaveBeenCalledWith("1.0.0");
    expect(onSuccess).toHaveBeenCalled();
  });

  it("does not call onSuccess on failure", async () => {
    mockRunNpmUpdate.mockResolvedValue({ success: false, output: "error" });
    const onSuccess = vi.fn();

    await handleCliUpdate("1.0.0", onSuccess);

    expect(onSuccess).not.toHaveBeenCalled();
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
